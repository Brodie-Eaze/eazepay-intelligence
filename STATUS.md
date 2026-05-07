# Status · EazePay Intelligence

The single source of truth for what's done, what's in progress, what's deferred.

**Snapshot:** 2026-05-08 · `feat/portfolio-silos` branch · pre-production · 88 unit tests + 6 live integration tests passing.

If a doc disagrees with this file, this file is authoritative until the doc is updated.

---

## ✅ Done

### Foundation

- Modular-monolith TypeScript codebase (`apps/api`, `apps/web`, `packages/shared-types`) on pnpm + Turborepo
- Prisma 5 schema with 30+ models, all migrations checked in, Postgres 16 + TimescaleDB + continuous aggregates
- Strict per-domain layout — every domain is `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts`
- Pino structured logs with PII redaction, request IDs, request log line per request
- Eight workers — `webhook`, `webhook-delivery`, `outbox`, `aggregation`, `revenue`, `export`, `alert`, `lifecycle`
- Single typeface (Inter), navy + light-blue palette, no traffic-light colors

### Auth / RBAC

- Cookie session (httpOnly + Secure + SameSite=Strict) with argon2id passwords
- CSRF double-submit on every mutation
- Refresh-token family with theft-detection (re-use of revoked token revokes the entire family)
- TOTP MFA opt-in per user
- WS connection auth via single-use Redis ticket (`GETDEL`)
- Roles: ADMIN / OPERATOR / INVESTOR / VIEWER, scope projection investor-aware
- Personal Access Tokens (`epi_pk_…`) with READ / WRITE / ADMIN scopes; bearer auth alongside cookie auth
- `requireScope` middleware unifies cookie role and PAT scope into one authorization gate
- Composite per-IP + per-email rate limit on `/auth/login`

### Data ingestion

- Signed-webhook ingress for BuzzPay / Pixie / MiCamp (HMAC SHA-256 + ±5min skew + Idempotency-Key)
- Two-layer idempotency: hot Redis SETNX → durable Postgres `UNIQUE(source, idempotency_key)`
- Outbox pattern — webhook ingress writes `webhook_events` + `outbox_events` in one tx; sweeper drains `FOR UPDATE SKIP LOCKED`
- Generic ingestion contract under `/api/v1/ingestion/*` — same Zod schemas as the signed-webhook path, PAT-authenticated, `Idempotency-Key` required, audit-logged
- Bulk endpoints (up to 500 events / batch) for backfills
- Multi-currency: `RevenueEvent.currency`, FX rate table with at-or-before lookup + triangulation, USD default
- Vendor `currency` field optional on every revenue-bearing webhook schema

### Portfolio (silos / holdco view)

- 8 Prisma tables for verticals, businesses, financial periods, revenue channels, product lines, unit economics, cohorts, headcount
- `PortfolioRepository` with replace-set semantics for bulk endpoints (deleteMany + createMany in single tx)
- Read + ingestion routes wired through the repository — no in-memory state
- Demo seed via `pnpm db:seed:portfolio` (deterministic mock generators)

### PII + privacy

- AES-256-GCM at rest with version-prefixed envelope
- HMAC-SHA-256 lookup hash for searchable equality
- PII access audited — `PII_ACCESSED` row on every reveal
- **Right-to-be-forgotten (GDPR Art. 17 / APP):** `POST /admin/rtbf` submits, lifecycle worker drains PENDING requests, every Application matching the email hash has its 5 encrypted PII columns overwritten with zero buffers in one transaction. AES-GCM IV+tag are part of the ciphertext bytes — zeroing makes the data cryptographically unrecoverable even with the master key
- **Lifecycle worker** (`pnpm worker:lifecycle`): webhook payload scrub at 90 days, refresh-token purge at 30 days post-expiry, RTBF processor

### Multi-database architecture

- Writer / reader split (`getPrismaWriter()`, `getPrismaReader()`) with transparent fallback when no replica configured
- Long-running worker role (`getPrismaLong()`) with 5-min `statement_timeout` for export + aggregation
- Reader is wired into every read-only route (analytics, customers, search, lenders, revenue, audit views)
- Read-after-write paths explicitly use the writer (saved-views delete, auth, /api-tokens, /portfolio writes)
- Reader runtime guard — Prisma `$use` middleware refuses every mutating action on the reader, throws `prisma.reader.write_blocked`
- Replication-lag check in `/health/ready` via `pg_last_xact_replay_timestamp()`, surfaces `replicaLagMs`
- PgBouncer-ready (`?pgbouncer=true` documented)
- `eazepay_app` runtime role with REVOKE on `audit_logs`, `revenue_events`, `outbox_events` + role-level `statement_timeout=30s`, `idle_in_tx=10s`, `lock_timeout=5s`
- Live integration tests against a streaming-replica topology (`docker-compose.test.yml` + `scripts/test-integration-db.sh`)

### Observability

- `/health`, `/health/live`, `/health/ready` (with replica + Redis status)
- Prometheus `/metrics` — Prisma pool + query metrics, namespaced by `db="writer|reader|long"`
- OpenTelemetry SDK auto-instrumented across HTTP, Postgres, Redis, BullMQ, Fastify
- W3C trace-context propagation across HTTP and BullMQ jobs
- `withSpan` helper for business-operation spans (wired into `alert.evaluate` + `rtbf.process`)
- Slow-query log at >500ms via Prisma `$on('query')`
- `prisma.reader.write_blocked` warnings surface in logs

### Alerting

- Closed declarative DSL — 8 metrics: `webhook_failure_rate`, `webhook_event_count`, `failed_login_count`, `application_count`, `revenue_amount`, `pii_access_count`, `ingestion_rejected_count`, `replication_lag_ms`
- Comparators: `gt / gte / lt / lte`
- Alert evaluation worker (`pnpm worker:alert`) on a 30s poll
- Per-rule cadence floor (no double-fire), cross-replica SETNX lock (no stampede)
- State machine: HIT → create OPEN alert + dispatch; HIT-while-open → no-op; COOL-while-open → auto-resolve
- Dispatcher with channel kinds — IN_APP, WEBHOOK (queued for delivery), EMAIL/SLACK (stubbed)
- Audit on every fire / resolve

### Reliability + scale

- Tiered rate limits — anonymous (100/min), authenticated (1k/min), ingestion (6k/min), webhook ingress (10k/min). Redis-backed cluster-wide. Fail closed on Redis outage.
- Per-route body limits — 1 MiB default / 8 MiB bulk / 2 MiB webhooks
- Worker concurrency env-driven (BullMQ)
- Graceful shutdown with re-entrant guard + 30s hard-timeout, drains in-flight requests then disconnects every Prisma client
- Server keep-alive timeout > ALB default (avoids 502s on idle connections)

### CI / supply chain

- `pnpm audit --prod --audit-level=high` gate on every PR
- Trivy filesystem scan (deps + transitives)
- Trivy container scan + CycloneDX SBOM artifact (90-day retention)
- CodeQL with `security-extended` query suite
- Each tool uploads SARIF to GitHub Code Scanning
- Live multi-DB integration tests run on every push (docker-compose primary + replica)
- Husky pre-commit (lint + typecheck), Dependabot

### Audit log

- Append-only enforced at the database role level
- Every mutation writes a row in the same transaction
- Action enum covers: auth, partners, PII access, webhooks, revenue events, alerts, RTBF, lifecycle purge, FX rate ingest, ingestion request/rejected, portfolio access/ingest

### Frontend (Next.js)

- 30+ pages across 10 sidebar groups: Today, Portfolio, People, Applications, Decision engine, Network, Money, Operations, Governance, Admin
- Real-time WebSocket connection with single-use ticket auth + exp-backoff reconnect
- `formatMoney` driven by `NEXT_PUBLIC_REPORTING_CURRENCY` / `_LOCALE` (defaults USD / en-US)
- Investor-scope projection (anonymized partner labels)

### Documentation

- `README.md` (this index), `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `STATUS.md`
- `docs/ARCHITECTURE.md`, `docs/PRD.md`, `docs/ROADMAP.md`, `docs/RUNBOOK.md`, `docs/ONBOARDING.md`, `docs/ORIENTATION.md`, `docs/KNOWN_ISSUES.md`, `docs/GLOSSARY.md`
- `docs/INGESTION.md` — dev-facing contract for plugging in any data source
- `docs/COMPUTE_LIMITS.md` — full scale envelope, failure-mode matrix, capacity math
- `docs/governance/SOC2_CONTROLS.md` — Trust Services Criteria mapping with line-of-code traceability
- `docs/governance/PRIVACY.md` — APP / GDPR alignment
- `docs/governance/DATA_CLASSIFICATION.md` — every field with classification + retention

---

## 🟡 In progress / soft

These are wired but not exercised in production.

- **Email + Slack alert dispatch** — channel kinds defined, Alert row durable, but external delivery stubbed (`reason: integration_pending` in audit). Vendor integrations are a v1.1 task.
- **Webhook subscription delivery retries** — service exists; not yet exercised end-to-end.
- **Aggregation worker continuous schedule** — ad-hoc trigger works; cron schedule pending.
- **Coverage thresholds in CI** — declared in `vitest.config.ts` (80% lines / 75% branches), not yet gating PRs.
- **PgBouncer in dev compose** — flag documented, not deployed by default.

---

## ❌ Not started — strategic decisions needed

These three are deal-blockers for an enterprise sale and require explicit direction before work begins. Each is multi-week and architectural.

### 1. Multi-tenancy retrofit (4–6 weeks)

The schema has no `Organization` model — every table (`Partner`, `Application`, `RevenueEvent`, `User`, `AuditLog`, `ApiToken`, `Alert`, `Case`, `Portfolio*`, …) is global. Retrofitting requires adding `tenantId` to every table, Postgres RLS policies, a tenant-scoped query layer, and rewriting every read path with implicit filtering. Foundation for SSO and per-tenant KMS.

### 2. SSO (SAML + OIDC + SCIM) — 1–2 weeks

No SSO of any kind. Login is email + password + optional TOTP. Enterprise buyers above ~500 seats demand IdP integration. Build vs buy (WorkOS) decision needed.

### 3. KMS migration (~1 day, gated on cloud choice)

PII keys + JWT secrets are env-var-loaded. The version-byte envelope is in place, but `KEY_VERSIONS` only ever has v1 — the rotation path is theoretical. Requires AWS KMS / GCP KMS / Vault before code changes.

---

## ❌ Not started — defensive but not deal-blocking

- RS256 JWT (currently HS256). Foundation for KMS rotation.
- Per-org MFA enforcement / IP allowlist / session limits (depends on multi-tenancy).
- Real distributed-tracing exporter (OTEL SDK is wired; no exporter chosen / no APM vendor).
- Backup verification + documented restore drills.
- Cross-region disaster-recovery topology.
- Customer SDKs (TypeScript / Python / Go).
- OpenAPI auto-emission + sandbox tenant for partner integration tests.
- Public status page (statuspage.io / Atlassian).
- Penetration-test engagement + bug-bounty program.
- E2E test suite expansion (1 Playwright spec today).
- Customer-facing API logs / webhook delivery viewer / usage dashboard.
- Application + revenue-event 7-year retention sweep (lifecycle worker has the rest).
- WS sticky-session strategy + per-connection quotas.

---

## How to use this file

- When you finish work, move the item from 🟡 / ❌ to ✅
- When you start the multi-tenancy / SSO / KMS arc, move it from "strategic" to "in progress"
- Always commit STATUS.md alongside the code change that flips an item — never let it drift

The detailed control mapping for SOC 2 lives in [`docs/governance/SOC2_CONTROLS.md`](docs/governance/SOC2_CONTROLS.md). The detailed honest-debt list lives in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md). The forward plan lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).
