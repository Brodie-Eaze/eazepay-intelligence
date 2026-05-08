# Platform v2 — Enterprise Data Center Roadmap

> **Status:** living document. Updated every working session. Source of truth for "what are we building, what's done, what's next."
>
> **North star:** a multi-tenant, audited, encrypted, lineage-tracked data platform that can ingest from every business and software product Brodie owns or operates, produce trustworthy cross-vertical intelligence, and survive a Big-4 audit + a Series-B technical due diligence + a hostile pen test without scrambling.

---

## Operating principles

These are not aspirational. Every PR is held against them.

1. **Quality over speed.** No demo-grade shortcuts. If a thing is going to be load-bearing in production, it's built to production standard the first time. We don't write code we're planning to throw away.
2. **No silent design choices.** Every decision that constrains future work goes in an ADR (see `docs/architecture/adr/`). If you can't find an ADR, the decision wasn't made; it was drifted into.
3. **Defence in depth.** Every isolation boundary (tenant, role, scope) is enforced at _both_ the application layer and the database layer. App bugs cannot defeat the database; database bugs cannot defeat the app.
4. **Reversibility.** Every migration is forward-only but data-safe. Destructive operations (drop column, drop table) require a deprecation notice in this doc + one full release cycle of dual-write/dual-read before removal.
5. **Tests pin behaviour, not implementation.** Tests describe what the system _guarantees_, in a way that survives refactors. Prefer integration tests against a real DB to mocked unit tests for any rule that touches money, PII, or auth.
6. **Crypto agility.** Every encrypted field is versioned. Every secret is rotatable without downtime. We assume any crypto choice we make today will need to change.
7. **The audit log is sacred.** It is append-only at the database role level (not just the app). Every state-changing action writes to it. RTBF cryptoshreds PII _in_ audit, never deletes audit rows.
8. **Tenant boundary is the strictest boundary in the system.** Stronger than role, stronger than scope. A bug that leaks across tenants is a P0 incident regardless of impact size.

---

## Phase map (priority order)

Sequential dependencies are marked. Phases without dependencies between them can run in parallel later, but Phase 1 blocks everything.

| Phase  | Theme                                                         | Status            | Depends on                                |
| ------ | ------------------------------------------------------------- | ----------------- | ----------------------------------------- |
| **1**  | Multi-tenancy retrofit + envelope encryption                  | **In progress**   | —                                         |
| **2**  | CDC + warehouse + dbt (analytical plane)                      | Pending           | Phase 1 (org_id on every row)             |
| **3**  | Enterprise auth — WorkOS SSO + SCIM                           | Pending           | Phase 1 (Org model exists)                |
| **4**  | Identity graph + consent ledger + PII vault                   | Pending           | Phase 1, Phase 2                          |
| **5**  | Data catalog + lineage + quality (DataHub + Soda + dbt tests) | Pending           | Phase 2                                   |
| **6**  | Vault for secrets + KMS for keys (replace env vars)           | Pending           | Phase 1 (KMS abstraction in place)        |
| **7**  | Multi-region active-passive + DR drills                       | Pending           | Phase 1, Phase 6                          |
| **8**  | SOC 2 + ISO 27001 evidence automation (Vanta/Drata)           | Parallel from now | — (begins immediately, deepens per phase) |
| **9**  | SLOs + synthetics + per-tenant cost observability             | Pending           | Phase 1                                   |
| **10** | Event mesh (Kafka/JetStream) + connector library              | Pending           | Phase 2, Phase 4                          |

---

## Phase 1 — Multi-tenancy retrofit + envelope encryption (current)

**Why first:** every other phase assumes "this row belongs to org X." Doing this later costs 4×; doing it under deal pressure costs 10×.

**Done = true** when all of the following hold:

- [ ] Every domain table has `org_id UUID NOT NULL REFERENCES organizations(id)` (or is explicitly classified GLOBAL_REFERENCE in `docs/architecture/multi-tenancy-blast-radius.md`)
- [ ] Postgres Row-Level Security policies are active on every TENANT_OWNED table; the runtime DB role cannot SELECT rows belonging to a different `current_setting('app.org_id')`
- [ ] Every Fastify route resolves the active org from the auth context and propagates it to every Prisma call
- [ ] Every Redis key, BullMQ queue name, and pub/sub channel includes `${orgId}` in the prefix
- [ ] AuditLog rows carry `org_id`; cross-tenant audit queries require a separate platform-staff role with its own audit trail
- [ ] Per-tenant DEK lifecycle implemented; each ciphertext envelope carries `[version][algorithm][keyId][iv][ct][tag]`; KMS abstraction has `LocalKms` (dev) and one production driver (AWS KMS or GCP KMS)
- [ ] Existing rows (encrypted with v0 global key) decrypt via fallback path; background re-encryption job converts v0 → v1 lazily
- [ ] Super-admin (Brodie) cross-tenant console exists, gated by `PlatformRole = STAFF`, every cross-tenant read writes a `PLATFORM_CROSS_TENANT_ACCESS` audit row
- [ ] Tenant deletion runbook exists: revoke memberships → cryptoshred DEK → archive metadata → optional Postgres-level row removal after retention period
- [ ] Integration tests prove tenant A cannot read tenant B's data via any API surface (negative tests for every route)
- [ ] ADR-001 (multi-tenancy) and ADR-002 (envelope encryption) are merged

**Sub-phases:**

- [x] **1.1** Organization + Membership + PlatformRole schema + migration. Bootstrap "default org" containing all current data. — **Done** (commit `7b792c0`)
- [ ] **1.2** `org_id` FK retrofit on every TENANT_OWNED table. Backfill default org for existing rows. Constraint becomes NOT NULL after backfill. **In progress.**
  - [x] **1.2a** `user_invitations`, `api_tokens` — orgId NOT NULL FK + indexes; `UserInvitation.role` enum migrated `UserRole → OrgRole`; service-layer rewired (Membership-on-accept). — **Done** (commit `db6adc4`)
  - [x] **1.2b** `audit_logs` — orgId nullable FK + index; `writeAuditLog` reads orgId from context. — **Done** (commit `db6adc4`)
  - [~] **1.2c** Core finance — migration written, **staged not applied** in `migrations-staged/`. Pending Phase 1.3 code coordination.
  - [~] **1.2d** Operational tables — migration written, **staged not applied**. Pending Phase 1.3.
  - [~] **1.2e** Portfolio slug→UUID PK — migration written, **staged not applied**. Highest invasiveness; coordinated with PortfolioRepository updates.
  - [x] **1.2f** New tables: `webhook_credentials`, `tenant_encryption_keys` (per ADR-002). — **Done** _(this session)_
- [~] **1.3** Tenant context middleware. **Partially done** _(this session)_: `resolveTenantFromPath`, `requireAuthAndTenant`, `requireOrgRole`, `requirePlatformRole` shipped in `auth.middleware.ts` + `rbac.middleware.ts`; `AuthContext` type extended. Pending: JWT extension to embed `orgId/orgRole`; Prisma `$extends` model middleware; route prefix migration to `/o/:orgSlug/`; ~67 route handlers + raw-SQL retrofits.
- [ ] **1.4** Postgres RLS policies. Every tenant-owned table gets `ENABLE ROW LEVEL SECURITY` + policy keyed on `current_setting('app.org_id')`.
- [~] **1.5** KMS scaffold. **Partial** _(this session)_: `KmsClient` interface + `LocalKmsClient` implementation + `KMS_DEV_SECRET` / `AWS_KMS_KEY_ARN` env vars. Pending: `AwsKmsClient`; `EncryptionService` v1 envelope encoder/decoder; per-org DEK provisioning seed; background re-encryption worker.
- [~] **1.6** Super-admin platform routes. **Partial** _(this session)_: `/platform/orgs` CRUD shipped (list/get/create/update/soft-delete), all gated by `requirePlatformRole` + audited via `PLATFORM_CROSS_TENANT_ACCESS`. Pending: `/platform/health`, `/platform/sessions`, `/platform/reconciliation`, `/platform/orgs/:id/rotate-dek`.
- [ ] **1.7** Redis/BullMQ tenant-scoped namespacing per blast-radius §4.

### Phase 1 — current session log

| Session | Date       | Commits                         | Sub-phases done                                                                                                                                                                                                                            |
| ------- | ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | 2026-05-08 | `7b792c0`, `db6adc4`, `074105b` | 1.1, 1.2a, 1.2b                                                                                                                                                                                                                            |
| 2       | 2026-05-08 | _(this session)_                | 1.2f (new tables); KMS scaffold; tenant middleware (`resolveTenantFromPath`, `requireOrgRole`, `requirePlatformRole`); platform routes scaffold (`/platform/orgs` CRUD); 1.2c + 1.2d + 1.2e migrations **staged** in `migrations-staged/`. |

### Migration staging directory

`apps/api/prisma/migrations-staged/` contains migrations that are **written but not applied**:

- `20260508170000_phase1_2c_core_finance_org` — orgId on partners, applications, lender_decisions, revenue_events (idempotency unique swap), pixie_metrics, revenue_aggregations, webhook_events, outbox_events. Hypertable PK constraints respected via non-PK + UNIQUE-index pattern.
- `20260508180000_phase1_2d_operational_org` — orgId on 14 operational tables.
- `20260508190000_phase1_2e_portfolio_uuid_pk` — PortfolioVertical/Business slug → UUID PK; `business_id` UUID FK on every child table. Highly invasive.

**Why staged not applied:** these all add `org_id NOT NULL` columns. Applying them without simultaneously updating every Prisma `create()` call site to supply `orgId` would break the running API (NOT NULL constraint violations). Phase 1.3 must land alongside.

To promote a staged migration:

1. Update Prisma schema for affected models (schema-diff docs at `docs/architecture/phase-1-2*-schema-diff.md` describe exact changes).
2. Update every code path creating rows on those tables to supply `orgId` (transitional helper pattern from Phase 1.2a: resolve issuer's first Membership; long-term: `req.auth.orgId` from tenant middleware).
3. `mv migrations-staged/<dir> migrations/`.
4. `pnpm --filter api db:migrate && pnpm --filter api db:generate`.
5. Run typecheck + tests + integration tests.

---

## Phase 2 — CDC + warehouse + dbt (analytical plane)

**Why:** today, analytics queries hit the operational Postgres. At scale this is (a) slow (b) inconsistent across verticals (c) a production-stability risk. Splitting operational and analytical planes is what enables real cross-vertical intelligence.

**Done = true** when:

- [ ] Postgres logical replication or Debezium emits CDC events for every TENANT_OWNED table
- [ ] Events land in object storage (S3/GCS) as Parquet via Iceberg or Delta Lake (ACID on a lake)
- [ ] dbt project exists; every transformation has a test (unique, not_null, accepted_values, custom assertions for money invariants)
- [ ] Query engine (ClickHouse or Snowflake or DuckDB-on-Iceberg) is wired into the dashboard for analytical queries
- [ ] Reverse ETL pushes warehouse-derived insights back to the operational app (e.g., propensity scores)
- [ ] Lineage from raw → staging → mart → dashboard is visible in DataHub (Phase 5 begins here)

---

## Phase 3 — Enterprise auth (WorkOS SSO + SCIM)

**Why:** Google OAuth doesn't pass procurement. Customers' security teams demand SAML 2.0 + SCIM provisioning.

**Done = true** when:

- [ ] WorkOS (or alternative) is integrated; SAML 2.0 IdP-initiated and SP-initiated flows work
- [ ] SCIM 2.0 endpoint provisions users into Membership rows on first assertion
- [ ] Just-in-time account creation on first SAML login (subject to org's allow-list)
- [ ] Service-to-service mTLS or SPIFFE identity for inter-service calls
- [ ] PAM solution (Teleport/StrongDM) for production DB access; no shared admin creds

---

## Phase 4 — Identity graph + consent ledger + PII vault

**Why:** the actual cross-vertical moat. Same human across BuzzPay + Pixie + MiCamp + Amala + AUREAN should be one `master_person_id`, not five `Application` rows.

**Done = true** when:

- [ ] Entity-resolution service runs on CDC stream; produces `master_person_id` with confidence-scored linkage
- [ ] Consent ledger records every consent grant/withdrawal per (person × vertical × purpose)
- [ ] Centralized PII tokenisation service issues stable tokens; raw PII lives in one vault (HashiCorp Vault / AWS Secrets Manager / dedicated PII service)
- [ ] RTBF propagates across the graph (delete in vertical A propagates per consent rules)
- [ ] Source-of-record routing rules documented per attribute (who is canonical for "phone"?)

---

## Phase 5 — Data governance (catalog + lineage + quality)

**Done = true** when:

- [ ] DataHub deployed; every Postgres + warehouse table auto-ingested
- [ ] Column-level PII classification annotations drive RTBF, masking, and retention policies (no code path duplication)
- [ ] Soda Core or Great Expectations runs in CI on every dbt model; schema drift, null-rate anomalies, freshness SLAs alarmed
- [ ] Master data management for reference data (currency codes, country codes, lender codes) — single source replaces today's scattered enums
- [ ] Every team owns specific datasets; ownership visible in catalog

---

## Phase 6 — Secrets + keys at enterprise standard

**Done = true** when:

- [ ] HashiCorp Vault or AWS Secrets Manager replaces env-var secrets (operational secrets only — KMS handles crypto keys)
- [ ] Every secret has a rotation cadence + automated rotation
- [ ] Webhook signing migrates from shared secret HMAC to asymmetric (Ed25519) for high-value vendors; key rotation without coordinated downtime
- [ ] Service principals get short-lived dynamic credentials, not long-lived API keys

---

## Phase 7 — Multi-region active-passive + DR

**Done = true** when:

- [ ] RPO and RTO targets documented per data class (financial ledger: RPO 0, RTO 15 min; analytics: RPO 1h, RTO 4h)
- [ ] Streaming replica in a second region (AU-Sydney + AU-Melbourne, or AU + ap-southeast-2 / 1 split)
- [ ] DNS-flip runbook + automation tested
- [ ] Object storage cross-region replication for the lake
- [ ] Quarterly chaos drills: kill writer, kill workers, kill Redis, kill region. Each drill produces a runbook update.
- [ ] Backup restore drill quarterly — a backup never restored is not a backup

---

## Phase 8 — Compliance evidence automation (parallel)

**Done = true** when:

- [ ] Vanta / Drata / Secureframe deployed; ~80% of SOC 2 evidence auto-collected
- [ ] SOC 2 Type II audit scheduled
- [ ] ISO 27001 gap assessment complete
- [ ] PCI scope documented and minimised (probably we never touch PAN; document the boundary)
- [ ] Privacy Impact Assessment template exists; one PIA per integration
- [ ] DPA templates ready (we-as-processor and we-with-subprocessor)
- [ ] Data residency controls enforced (org config: `data_region = 'au'` → routes traffic + storage to AU only)

---

## Phase 9 — Observability beyond OTel

**Done = true** when:

- [ ] SLOs + error budgets documented per critical user journey, paged on burn rate
- [ ] Synthetic monitoring (Checkly) runs login + invite + accept + ingest every 5 min, pages on failure
- [ ] Logs aggregated (Loki/Datadog/Sumo); cross-service trace+log correlation via traceId
- [ ] Per-tenant cost dashboard (CPU sec, DB rows, S3 GB, Redis ops) — drives pricing AND finds runaway tenants
- [ ] Anomaly detection on auth logs, webhook failure rates, PII access spikes — feeds existing Alert engine with statistical baselines

---

## Phase 10 — Integration plane (event mesh + connectors)

**Done = true** when:

- [ ] Kafka / NATS JetStream deployed as the cross-vertical event bus
- [ ] Schema registry (Confluent / Buf) with versioned event schemas; breaking-change linter in CI
- [ ] Connector library: Salesforce, HubSpot, Stripe, QuickBooks, Xero, Zendesk via Merge.dev or Nango (buy) plus 2-3 in-house for tighter integration
- [ ] Generic outbound webhook framework already exists — extend for connector use

---

## Engineering practices (always-on)

These run continuously, not as phases.

- **ADRs** for every load-bearing decision. Numbered, dated, immutable once accepted. Index in `docs/architecture/adr/README.md`.
- **RFCs** for cross-cutting changes (anything that touches >3 files in different domains).
- **Quarterly DR drill.** Real failover, real timing, written-up incident review even though it's planned.
- **Annual third-party pen test.** Bug bounty in parallel.
- **Architecture-critic review** on every major PR (we have an agent for this; use it).

---

## ADR index

Maintained at `docs/architecture/adr/README.md`. Every numbered ADR is immutable once status = ACCEPTED. Superseding decisions get a new ADR that links to the previous.

---

## Resumption protocol

When a session starts:

1. Read this doc.
2. Check todo list (TodoWrite) — that's session-local.
3. Find the current in-progress phase. Read its done-criteria.
4. Find the most recently merged ADR. Read it.
5. Run `pnpm typecheck && pnpm test` to confirm clean baseline.
6. Continue. Update this doc + todo list as work progresses. Mark sub-phase items with `[x]` only when truly done — partial = `[ ]`.

When a phase completes:

1. All boxes ticked.
2. Architecture-critic agent review of the phase as a whole.
3. Update the phase status in the table above to `Done` with the commit hash.
4. Move on.
