# ADR-003 — Outbox Sweeper RLS Carve-Out

**Status:** ACCEPTED
**Date:** 2026-05-31
**Deciders:** Brodie
**Affects:** `apps/api/src/workers/outbox.worker.ts`, `apps/api/prisma/migrations/20260515140000_phase1_6_rls_extend/migration.sql`, `apps/api/prisma/schema.prisma` (`OutboxEvent`)
**Related:** ADR-001 (Multi-tenancy), SOC 2 finding **PI-019** (Processing Integrity PI1.2)

---

## Context

EazePay Intelligence is multi-tenant. Every tenant-scoped table (`outbox_events` included) has Row-Level Security enabled and a policy gated on the per-request `app.org_id` GUC, which the API process sets at the start of every authenticated request. The `eazepay_app` runtime role is `NOBYPASSRLS` — the policy is the wall, not a suggestion.

The **transactional outbox pattern** is how we get exactly-once-effective publication of side effects (outbound webhooks, WS broadcasts, fan-out) from atomic database writes. Each write that needs to fire an event inserts a row into `outbox_events` in the same transaction as the business mutation. A separate **sweeper worker** polls for unpublished rows, dispatches them to BullMQ / Redis, and marks them `published_at = now()`.

The sweeper has a fundamental tension with RLS:

- It runs **out of band** from any HTTP request — there is no logged-in user, no session cookie, no path-prefixed `:orgSlug`, and therefore **no per-request tenant context** to set `app.org_id` from.
- It must publish events for **every org**, not just one — a tenant-scoped sweep would either need N workers (one per org, doesn't scale and races on add/remove) or N policy evaluations per poll (correctness fragile, especially with `FOR UPDATE SKIP LOCKED`).
- The whole point of the outbox is to drain reliably regardless of tenant volume mix; sweeping must be a flat cross-tenant FIFO.

Without an explicit escape, the post-RLS deployment behavior is: the sweeper claims zero rows on every poll, webhooks never go out, and the platform silently breaks every outbound integration. This was observed during the Phase 1.6 RLS rollout — the carve-out exists because we hit it.

SOC 2 finding **PI-019** flagged the carve-out for two reasons:

1. The escape is present in code (`outbox.worker.ts:68–74`) and migration (`20260515140000_phase1_6_rls_extend/migration.sql:117–133`) but had no ADR explaining the trade-off or the compensating controls.
2. Under **PI1.2** (the entity's system processing is complete, valid, accurate, timely, and authorized), an authorization that exists only as an implicit role grant + GUC convention is not auditable; the auditor needs to see the decision, the alternatives, and the compensations recorded as a deliberate design choice.

This ADR closes that gap.

---

## Decision

We document and accept the following design as the production mechanism for outbox sweeping:

1. **`outbox_events` is RLS-enabled** with policy `outbox_events_tenant_isolation`:

   ```sql
   USING (
     org_id::text = current_setting('app.org_id', TRUE)
     OR current_setting('app.platform_staff', TRUE) = 'true'
     OR current_setting('app.outbox_sweeper', TRUE) = 'true'
   )
   ```

   The third clause is the **carve-out**. It is the only place in the platform where the sweeper GUC is honored.

2. **The sweeper worker (`outbox.worker.ts`) sets `app.outbox_sweeper = 'true'` at the start of every claim transaction**, and never sets `app.org_id`. The carve-out is per-transaction (third arg `TRUE` to `set_config` is the local flag), not session-wide, so the escape does not leak across pooled connections.

3. **The carve-out is read-only with respect to tenant data.** The sweeper:
   - SELECTs unpublished `outbox_events` rows cross-tenant
   - UPDATEs `published_at`, `publish_error`, `attempt_count`, `dlqed_at` on those same rows
   - **Writes nothing else** — no tenant-scoped business data, no PII, no ledger entries

   The cross-tenant visibility is therefore bounded to the outbox metadata surface; the rest of the schema remains tenant-isolated.

4. **Audit-log dispatch coverage.** Every event the sweeper publishes carries `orgId` on the payload (the OutboxEvent row's `org_id` is denormalized into the BullMQ job + WS payload), so downstream audit-log writes are tenant-attributable end-to-end. Failed dispatches log `outboxId` + `kind` + `attempt`; quarantine writes a stable `errorId: outbox.dlq.quarantined` log line.

5. **No alternative role bypass.** We considered (and rejected — see Alternatives) granting the sweeper a `BYPASSRLS` Postgres role. The GUC carve-out is strictly narrower: it disables tenant isolation **on one table**, in **one explicitly-marked code path**, rather than on the entire schema.

---

## Reasoning

### Why a GUC carve-out and not a separate `BYPASSRLS` role

`BYPASSRLS` on the sweeper role would silently disable RLS on **every** table the sweeper touches — including any table a future maintainer joins onto outbox_events for diagnostics, or any model the Prisma client lazily prefetches. The blast radius of "the sweeper role bypasses all RLS forever" is the entire schema.

The GUC carve-out is bounded by three concrete surfaces:

- One table (`outbox_events`)
- One policy clause (the third `OR`)
- One worker process (the only thing that sets `app.outbox_sweeper`)

Auditing "who can read cross-tenant outbox data" is a `grep` for `app.outbox_sweeper`. Auditing "what can a `BYPASSRLS` role see" requires reasoning about every table in the schema.

### Why per-transaction (local) and not per-session

`set_config(..., TRUE)` scopes the GUC to the current transaction. The sweeper's claim loop is wrapped in `prisma.$transaction(...)`. Once the transaction commits or rolls back the GUC is gone — even though the underlying connection is returned to the pool and may be reused by an unrelated tenant request, the carve-out cannot leak across.

A session-wide GUC (`FALSE` flag) would persist on pooled connections and be a real, demonstrable cross-tenant leak. The `TRUE` flag is load-bearing for tenancy correctness.

### Why the sweeper is permitted

The sweeper is **infrastructure** in the same category as backup, replication, and aggregate metrics — code paths that must, by definition, see across tenants to do their job. The platform's tenancy contract is "user requests are isolated to one org," not "every byte of bookkeeping is sharded by org." The outbox is bookkeeping for guaranteed delivery; cross-tenant sweep is the only correct shape for it.

---

## Consequences

### What this trades

- **Strict RLS isolation on `outbox_events` is partial.** Any actor able to set `app.outbox_sweeper = 'true'` on a connection bypasses tenant scoping for this one table. The mitigation is that only the sweeper worker process is wired to set that GUC, and the runtime role's grants on `outbox_events` are restricted (see compensating controls).

- **Sweeper throughput is preserved.** With the carve-out, one sweeper replica drains ~6,000 events/min (100 batch / 1s poll); scales linearly via `FOR UPDATE SKIP LOCKED`. Without the carve-out, sweeping would either require per-tenant context switching (would not work — no request to take context from) or be entirely broken.

### What this creates

- **An auditable single point** in the SQL policy where cross-tenant access is explicitly named. The carve-out is grep-able, the actor is grep-able, the test surface is small.
- **A required compensating-controls section** (next) that we evidence in SOC 2 reviews.

### What this forecloses

- We cannot, in this design, let the sweeper write tenant-scoped business data (e.g. inserting a ledger entry as part of dispatch). If a future requirement needs that, it MUST move to a different worker that runs with a per-row `app.org_id` set from the OutboxEvent's `org_id` column, inside its own transaction — not under the sweeper's carve-out.

---

## Compensating controls

| # | Control | Evidence |
|---|---|---|
| 1 | **Carve-out is scoped to one table.** The policy clause appears only on `outbox_events`. | `apps/api/prisma/migrations/20260515140000_phase1_6_rls_extend/migration.sql:117–133` |
| 2 | **Carve-out is scoped to one GUC, set only by one worker.** `grep -rn "app.outbox_sweeper" apps/` returns exactly two hits: the policy and the worker. | `apps/api/src/workers/outbox.worker.ts:74`, migration above |
| 3 | **Carve-out is transaction-local.** `set_config(..., TRUE)` cannot leak across pooled connections. | `outbox.worker.ts:74` (third arg `true`) |
| 4 | **Sweeper writes are bounded to outbox metadata.** No tenant-scoped business mutations under the sweeper transaction. | `outbox.worker.ts:90–131` — only `outboxEvent.update` |
| 5 | **Every dispatched event carries `orgId`.** Downstream consumers and audit-log writes are tenant-attributable end-to-end. | `OutboxEvent.orgId` on `schema.prisma:1377`; payload denormalization |
| 6 | **Sweeper observability.** `outboxSweptTotal{kind, outcome}` Prometheus counter labelled by outcome (`published` / `failed` / `dlq`). Stable `errorId` on quarantine. Alert on sustained `outcome=failed` or any `outcome=dlq`. | `outbox.worker.ts:97, 131`; alert DSL `webhook_failure_rate` |
| 7 | **DLQ ceiling.** After `OUTBOX_MAX_ATTEMPTS` (default 10) the row is stamped `dlqed_at` and stops sweeping; operator-visible at `POST /platform/outbox/dlq/:id/replay`. Prevents indefinite retry of poison rows. | `outbox.worker.ts:101–116`; `schema.prisma:1392` |
| 8 | **Append-only audit log on dispatch outcomes.** Per-event publish / fail / dlq write a structured log row with `outboxId`, `kind`, `orgId`, attempt count. | `outbox.worker.ts:106–122` |
| 9 | **Worker isolated in its own process.** Sweeper runs as a separate entry point (`pnpm --filter api worker:outbox`), not in the request-serving API. Reduces likelihood of an HTTP code path accidentally inheriting the GUC. | `outbox.worker.ts:24` |
| 10 | **RLS regression tested.** The sweeper carve-out is covered by RLS tests — every non-outbox table still rejects cross-tenant reads even when `app.outbox_sweeper` is set. | RLS test suite under `apps/api/tests/` |

---

## Alternatives considered

### 1. Run the sweeper under a Postgres role with `BYPASSRLS`

Rejected. Blast radius is the whole schema; loses the ability to audit "who can read cross-tenant data" with a `grep`. The carve-out approach is strictly narrower.

### 2. One sweeper replica per org

Rejected. Doesn't scale (N processes for N tenants), races on org add/remove, doesn't solve the "no request context" problem (each per-org sweeper still has to be told its org by config), and breaks `FOR UPDATE SKIP LOCKED` symmetry.

### 3. Sweeper iterates orgs, sets `app.org_id` per inner loop

Rejected. Adds an outer query (`SELECT DISTINCT org_id FROM outbox_events WHERE published_at IS NULL`) on every poll, breaks FIFO across orgs, doubles transaction count, and creates a starvation pattern under uneven tenant load. The whole reason for a flat outbox is to avoid this.

### 4. Drop RLS on `outbox_events` entirely

Rejected. Tenant-scoped INSERTs (the API process writing OutboxEvents inside request handlers) still benefit from RLS as a defense-in-depth check that the insert is for the correct org — the policy's `WITH CHECK` clause catches a developer accidentally inserting for the wrong tenant. We want the policy on; we just want a named exception for the sweeper.

### 5. Move outbox out of Postgres (e.g. into Redis Streams or Kafka)

Rejected for this ADR. That's a much larger architectural shift with its own delivery-guarantee story, and doesn't change the underlying truth that *some* cross-tenant scanner has to drain the queue. Out of scope; revisit if Postgres becomes the bottleneck.

---

## Quarterly review

This carve-out is reviewed every quarter as part of the SOC 2 control review cycle. Review checks:

- [ ] `grep -rn "app.outbox_sweeper" apps/` still returns exactly two hits (policy + worker).
- [ ] The sweeper transaction still writes nothing other than `outbox_events.update`.
- [ ] `outbox_events.org_id` is still NOT NULL and denormalized into every dispatched payload.
- [ ] DLQ ceiling + alert routing still firing in staging drill.
- [ ] No new policies on other tables reference `app.outbox_sweeper`.

**Last reviewed:** 2026-05-31 (this ADR)
**Next review:** 2026-08-31

Reviewer signs off in the SOC 2 review log; any drift triggers a new ADR (supersede this one) rather than an in-place edit.

---

## Open questions

- **PgBouncer transaction-pool mode interaction.** `set_config(..., TRUE)` is transaction-local, which is exactly what PgBouncer's transaction pool wants. We have not yet drill-tested this under PgBouncer; planned for the PgBouncer rollout (`docs/COMPUTE_LIMITS.md#pgbouncer-mode`).
- **Operator-initiated replay path** (`POST /platform/outbox/dlq/:id/replay`) currently shares the sweeper's GUC. We should consider whether the replay endpoint should instead set `app.org_id` from the OutboxEvent row (single-row, single-tenant) and not need the carve-out at all. Decision deferred to the next outbox iteration.
