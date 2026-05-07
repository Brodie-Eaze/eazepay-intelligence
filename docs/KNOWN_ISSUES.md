# Known Issues · "Where the bodies are buried"

The honest list of tech debt, hacks, and known gaps. **Read this before you make architectural assumptions.**

For the canonical done / in-progress / not-done split, see [`STATUS.md`](../STATUS.md).

---

## Recently resolved (during the v0.2 cycle)

These were on this list at v0.1 and have since been closed. Documented for context on what shifted:

- ✅ **Outbox pattern** — webhook ingest writes `WebhookEvent` + `OutboxEvent` in one tx; sweeper drains via `FOR UPDATE SKIP LOCKED`
- ✅ **Durable idempotency** — Redis SETNX hot path + Postgres `UNIQUE(source, idempotency_key)` cold path
- ✅ **`eazepay_app` runtime DB role** — created in `init-timescale.sql` with REVOKE on `audit_logs`, `revenue_events`, `outbox_events` + role-level `statement_timeout=30s`, `idle_in_transaction=10s`, `lock_timeout=5s`
- ✅ **Audit log retention worker** — `lifecycle.worker.ts` clears `webhook_events.payload` at 90 days, purges expired refresh tokens at 30 days post-expiry
- ✅ **Refresh-token garbage collection** — same lifecycle worker
- ✅ **Right-to-erasure / cryptoshred** — `RtbfService.process()` overwrites the 5 encrypted PII columns with zero buffers in one transaction; AES-GCM IV+tag are part of the ciphertext bytes so zeroing makes the data cryptographically unrecoverable
- ✅ **Webhook payload PII at 90 days** — lifecycle worker scrubs `webhook_events.payload` past TTL while keeping the row + metadata for audit
- ✅ **Multi-currency** — `RevenueEvent.currency` respected, `FxService` handles same/direct/inverse/triangulate, hardcoded `currency: 'AUD'` removed
- ✅ **Multi-DB writer/reader split** — `getPrismaWriter()` + `getPrismaReader()` + `getPrismaLong()` with reader runtime guard refusing every mutating action
- ✅ **Alert engine** — was claimed but not running in v0.1; now evaluates rules every 30s, fires + dispatches + audits
- ✅ **OpenTelemetry** — full SDK across HTTP, Postgres, Redis, BullMQ, Fastify with W3C trace-context propagation
- ✅ **Prometheus `/metrics`** — Prisma metrics preview wired, namespaced by `db="writer"|"reader"|"long"` label
- ✅ **CI dependency + container scanning + SBOM** — `pnpm audit` + Trivy fs + Trivy image + CodeQL all gate every PR; CycloneDX SBOM as a 90-day artifact
- ✅ **Composite uniqueness on revenue_events** — `(source, idempotency_key)` unique
- ✅ **External decision ID** — `lender_decisions.external_decision_id` is unique; upsert by vendor's literal `decisionId`
- ✅ **Refresh-token storage** — HMAC-SHA-256 keyed with `JWT_REFRESH_SECRET` (was bare SHA-256)
- ✅ **Connection pool tuning** — documented + enforced via DATABASE_URL query string
- ✅ **Silent failure in outbound webhook fanout** — `dispatchOutbound` rethrows so worker retry semantics apply
- ✅ **Portfolio persistence** — was in-memory `Map` in v0.1; now 8 Prisma tables with replace-set tx semantics
- ✅ **Live multi-DB integration tests** — `docker-compose.test.yml` + `scripts/test-integration-db.sh` exercises real streaming replication

---

## Open · Architecture

### `exactOptionalPropertyTypes` is off

The shared `tsconfig.base.json` does not enable `exactOptionalPropertyTypes`. Surfaced ~30 friction errors at the Zod ↔ Prisma boundary where parsed input has explicit `undefined` and Prisma update types don't accept it for absent fields. Pragmatic call: keep `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. Re-enable when we either (a) wrap Prisma with a thin adapter that strips undefined keys, or (b) use only Zod-inferred types for repository inputs.

### Next.js `typedRoutes` is off

The sidebar nav is a config table (string `href`s). With `typedRoutes: true`, TS demands literal types in `<Link href>`. Off until we generate the nav from a typed source.

### OpenAPI codegen pipeline not running

The plan (ADR-008) is for `@asteasolutions/zod-to-openapi` to emit `openapi.json` and `openapi-typescript` to consume it into `packages/shared-types/src/api.ts`. **Today, the frontend mirrors backend response shapes manually in `apps/web/src/lib/types.ts`.** Drift risk is real. Wiring is in `ROADMAP.md` P2.

### Inferred webhook contracts

`apps/api/src/domains/webhooks/webhook.schemas.ts` is a best-effort guess at what BuzzPay / Pixie / MiCamp will send. Rejection is loud (Zod 422) but a real partner integration may surface fields we don't expect. **The HMAC + idempotency layer is correct regardless** — we won't accept anything unsigned, replays are deduped — but the per-event Zod schemas need partner sign-off before going to production traffic. Tracked under ADR-006.

### `WsEvent` typing is permissive at the publisher boundary

`publishWsEvent(event: object)` accepts any object — the `WsEvent` discriminated union is the consumer-facing wire contract but isn't enforced on producers. The TypeScript inference around the `withPartnerLabel<E>` generic + discriminated union was over-strict and producer code became unreadable. Documented in detail at the top of `apps/api/src/shared/utils/ws-publisher.ts`. A wire-format snapshot test would catch drift at runtime; deferred to P2.

---

## Open · Database

### Timescale not enabled in dev by default

The Prisma schema dropped the `extensions = [timescaledb]` declaration so the platform runs on stock Postgres locally. Production needs `init-timescale.sql` run after `prisma migrate deploy` to create the hypertables and continuous aggregates. **Don't assume Timescale is present in dev.** Performance differences between dev and prod analytics queries are significant; revisit if dev queries hit pathological cases.

### Application + revenue 7-year retention sweep

`DATA_CLASSIFICATION.md` commits to 7-year retention. The lifecycle worker handles webhook payload + refresh tokens. Application + revenue-event sweep is **not** in there because those are append-only by REVOKE and the regulatory horizon is far enough out that lifecycle deletion is a v1.1+ concern. When it lands, same pattern applies: a new task in the worker plus a separate `eazepay_lifecycle` role with the REVOKE relaxed.

---

## Open · PII handling

### `PII_HASH_SECRET` rotation is expensive

The deterministic email/phone hashes use HMAC-SHA-256 with a single static pepper. Rotating requires re-hashing every existing PII row. **Document a backfill plan before rotation is ever attempted.** A migration script template should exist; doesn't yet.

### MFA secret stored plaintext

`users.mfa_secret` is plaintext in the database. It should be encrypted under the same `PII_ENCRYPTION_KEY` envelope used for consumer PII. Real-world risk is low (DB read implies env access in this deployment); fix is straightforward — wrap reads/writes through the encryption helper. Tracked.

### No DSAR JSON export endpoint

GDPR Art. 20 / APP 12 require subject data export on request. The `GET /customers/:hash` endpoint returns most of it but there's no portable JSON export. Today this is a manual operator process. ROADMAP P2.

### KMS migration not yet done

PII keys + JWT secrets are env-var-loaded. The version-byte envelope on PII ciphertext is in place, but `KEY_VERSIONS` only ever has v1 — the rotation path is theoretical. Need cloud + KMS vendor decision before code changes (ROADMAP P0).

---

## Open · Operational

### No production deployment yet

The Dockerfile is ready and the docker-compose works locally. **Cloud target undecided** — Fly / Railway / ECS / GCP. Roadmap P1.

### Backups not exercised

Backup design (nightly `pg_dump` + 4-hourly WAL archive) is documented. **Restore has never been tested.** First DR drill is a P1 item before SOC 2 fieldwork.

### Email + Slack alert dispatch is stubbed

The Alert row is durable; channel kinds are defined; IN_APP and WEBHOOK delivery work. EMAIL and SLACK record `dispatched: false, reason: integration_pending` in the audit log. Vendor integrations are a v1.1 task once a delivery vendor (Postmark, Mailgun, Slack Incoming Webhook, etc.) is picked.

### No on-call rotation

Solo-maintainer phase. Production launch needs a documented rotation + runbook. `RUNBOOK.md` covers the _what_; the _who_ needs to be filled in.

### Aggregation worker schedule

`aggregation.worker.ts` exists and runs jobs from the queue. There's no scheduler that enqueues the daily/monthly rollups on a cron. P3 in ROADMAP.

---

## Open · Frontend

### Live ticker dropped from Overview

The `Live event stream` panel that subscribed to the WebSocket and rendered events in real-time was removed during a layout cleanup — it was visually empty most of the time and competed with the more useful Recent Activity table. The full feed lives at `/live`. The WS connection is still established + the heartbeat indicator still shows in the topbar. Re-add if it earns its place.

### `Funnel` and `Cohorts` pages exist but aren't in nav

Removed from the sidebar during a design pass; `/funnel` and `/cohorts` still resolve. Decide whether to keep the routes or hard-delete the pages.

### Hand-mirrored types in `apps/web/src/lib/types.ts`

See "OpenAPI codegen pipeline not running" above. Same root cause.

### Investor mode UI dropped, but `denyInvestorScope` middleware still in code

Investor scope was removed from the operator UI in a design pass. The server-side `denyInvestorScope` middleware still gates several routes — harmless but dead code if investor mode never returns. Either re-surface investor mode or remove the middleware on a future sweep.

---

## Open · Testing

### Coverage thresholds set but not gating CI

`vitest.config.ts` declares 80%/75% thresholds. CI runs `pnpm test` but doesn't run `--coverage` or fail on threshold breach. Wiring this is one line in CI. ROADMAP P2.

### Playwright e2e is one test deep

`apps/web/playwright.config.ts` + `tests/e2e/login-and-overview.spec.ts` exist. Real coverage (PII reveal, partner create, scope toggle, RTBF submit) is in ROADMAP P2.

### No load-test harness

`docs/COMPUTE_LIMITS.md` documents target capacity; no k6/Artillery/Gatling script exercises it. Worth wiring before any partner pilot.

---

## Open · Build

### No version pinning of pnpm beyond `packageManager` field

`package.json` declares `"packageManager": "pnpm@9.12.0"` but doesn't enforce. Corepack respects it; CI happens to use 9. A bare `pnpm install` on a workstation with pnpm 8 would emit a warning but not fail. Acceptable for now.

### Turbo remote cache wired but disabled

`turbo.json` has the remote cache config commented in. No vendor account configured. Local cache works fine.

---

## What is intentionally not built

Listed at the bottom of `ROADMAP.md`. Headline:

- **No microservices.** Modular monolith is the right shape.
- **No customer-facing surface.** The platform is operator-only by product definition.
- **No additional chart libraries.** Recharts is sufficient.
- **No GraphQL.** REST + Zod + OpenAPI codegen will cover the contract surface.
