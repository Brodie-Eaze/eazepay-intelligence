# SOC 2 Controls Map · EazePay Intelligence

This document maps every relevant SOC 2 Trust Services Criterion (TSC) to a concrete control in this codebase or process. Use it as the auditor-facing index when engaging a SOC 2 Type 1 reviewer.

**Scope:** Common Criteria (Security) + Confidentiality + Privacy. Availability and Processing Integrity in scope for Type 2.

**Status legend:**

- ✅ Implemented and evidenced in code
- 🟡 Implemented in code, but evidence collection / monitoring pending
- ⏳ Designed and documented; not yet implemented

---

## CC1 — Control Environment

| TSC   | Control                                                    | Status | Evidence                                                                       |
| ----- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| CC1.1 | Demonstrates commitment to integrity and ethical values    | ✅     | `CONTRIBUTING.md` — code of conduct, conventional commits, PR review checklist |
| CC1.2 | Board oversight (or founder governance)                    | ⏳     | Single-founder stage. Pre-Series A advisory board planned.                     |
| CC1.3 | Establishes structures, reporting lines, authorities       | 🟡     | `RBAC` matrix in `ARCHITECTURE.md` §14.2; org chart pending CTO hire.          |
| CC1.4 | Demonstrates commitment to competence                      | ⏳     | Hiring plan + role JDs are next-quarter deliverables.                          |
| CC1.5 | Holds individuals accountable for control responsibilities | ✅     | Audit log records actor for every mutation; `audit_logs` table append-only.    |

## CC2 — Communication and Information

| TSC   | Control                                          | Status | Evidence                                                                                         |
| ----- | ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| CC2.1 | Internal information for control execution       | ✅     | This doc + `SECURITY.md` + `PRIVACY.md` + `DATA_CLASSIFICATION.md`.                              |
| CC2.2 | Communicates control responsibilities internally | 🟡     | `CONTRIBUTING.md`, `ONBOARDING.md`. Onboarding presentation to be created at first hire.         |
| CC2.3 | Communicates with external parties               | 🟡     | `SECURITY.md` includes vulnerability disclosure address. Customer-facing privacy notice pending. |

## CC3 — Risk Assessment

| TSC   | Control                        | Status | Evidence                                                                                                                              |
| ----- | ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| CC3.1 | Specifies suitable objectives  | ✅     | `PRD.md` §KPIs + `ROADMAP.md` define product + security objectives                                                                    |
| CC3.2 | Identifies and analyzes risk   | ✅     | STRIDE model in `SECURITY.md`                                                                                                         |
| CC3.3 | Considers fraud risk           | 🟡     | Refresh-token theft detection (family-revoke). Webhook replay protection. Customer-side fraud is upstream (BuzzPay's responsibility). |
| CC3.4 | Identifies and assesses change | ✅     | Conventional commits + ADRs in `ARCHITECTURE.md`                                                                                      |

## CC4 — Monitoring Activities

| TSC   | Control                                         | Status | Evidence                                                                                                                                         |
| ----- | ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CC4.1 | Selects, develops, performs ongoing evaluations | 🟡     | `/ops/health` polls every 10s (DB latency, Redis latency, queue depth, webhook success rate, PII access count). External alerting not wired yet. |
| CC4.2 | Communicates deficiencies                       | ⏳     | On-call rotation + alert routing pending production deploy                                                                                       |

## CC5 — Control Activities

| TSC   | Control                                             | Status | Evidence                                                                                 |
| ----- | --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| CC5.1 | Selects + develops control activities               | ✅     | This document                                                                            |
| CC5.2 | Selects + develops general controls over technology | ✅     | `ARCHITECTURE.md` ADRs                                                                   |
| CC5.3 | Deploys through policies and procedures             | 🟡     | Code-level policies enforced; procedural docs (incident response, access review) pending |

## CC6 — Logical and Physical Access Controls

| TSC       | Control                                                                    | Status | Evidence                                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC6.1** | Implements logical access security software, infrastructure, architectures | ✅     | RBAC enforced in `shared/middleware/rbac.middleware.ts`. Roles: ADMIN / OPERATOR / INVESTOR / VIEWER. Matrix in `ARCHITECTURE.md` §14.2. Cookie-based session w/ httpOnly + Secure + SameSite=Strict.                                                                                              |
| **CC6.2** | Registers / authorizes new users prior to issuing credentials              | ✅     | `POST /api/v1/users` is admin-only. New user creation writes `USER_CREATED` audit row. UI at `/admin`.                                                                                                                                                                                             |
| **CC6.3** | Authorizes, modifies, removes access                                       | ✅     | `PATCH /users/:id` (role change) + `DELETE /users/:id` (soft-delete + revoke all sessions) — admin-only. Both audit-logged. UI live at `/admin`.                                                                                                                                                   |
| **CC6.4** | Restricts physical access                                                  | n/a    | Cloud-hosted; provider responsibility (target: Fly / AWS — physical security inherited from SOC 2 vendors).                                                                                                                                                                                        |
| **CC6.5** | Discontinues logical and physical protections over physical assets         | n/a    | Same as CC6.4                                                                                                                                                                                                                                                                                      |
| **CC6.6** | Implements logical access security measures against external threats       | ✅     | Helmet headers. CORS allowlist (env-driven). Per-IP rate limit (Fastify rate-limit). Per-(IP, email) composite rate limit on `/auth/login`. CSRF double-submit token on every state-changing route. HMAC SHA-256 + 5-min timestamp tolerance + idempotency-key replay protection on every webhook. |
| **CC6.7** | Restricts data transmission, movement, removal                             | ✅     | TLS at the edge (configured at deploy). Cookie flags. PII encrypted in transit and at rest. Logger redaction list covers all known PII paths.                                                                                                                                                      |
| **CC6.8** | Implements controls over malware                                           | 🟡     | Dependency scanning via `pnpm audit` documented in `CONTRIBUTING.md`. Renovate or Dependabot to be wired in CI.                                                                                                                                                                                    |

## CC7 — System Operations

| TSC       | Control                                           | Status | Evidence                                                                                                                                                   |
| --------- | ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC7.1** | Detects and monitors infrastructure for anomalies | 🟡     | `/health` endpoint with DB + Redis latency. `/ops/health` admin dashboard. WebhookEvent records every receipt + processing outcome. Alerting pipe pending. |
| **CC7.2** | Monitors system components                        | 🟡     | Pino structured logs with request IDs. Future OpenTelemetry exporter (placeholders in `index.ts`).                                                         |
| **CC7.3** | Evaluates security events                         | ✅     | Audit log records `USER_LOGIN_FAILED`, `WEBHOOK_FAILED`, `PII_ACCESSED` events. UI surfaces them at `/audit`, `/audit/pii`, `/audit/logins`.               |
| **CC7.4** | Responds to identified security incidents         | 🟡     | Incident response playbook in `SECURITY.md`. Drill cadence pending.                                                                                        |
| **CC7.5** | Recovers from identified security incidents       | 🟡     | Backup strategy in `ARCHITECTURE.md` §14.10. RPO ≤ 4h, RTO ≤ 30 min designed; backup execution pending production deploy.                                  |

## CC8 — Change Management

| TSC       | Control                                                                                   | Status | Evidence                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC8.1** | Authorizes, designs, develops, configures, documents, tests, approves, implements changes | ✅     | Conventional commits. PR template enforces description + testing + screenshots. ADRs for architectural changes. CI runs typecheck + lint + test on every PR (`.github/workflows/ci.yml`). |

## CC9 — Risk Mitigation

| TSC       | Control                                                                           | Status | Evidence                                                                                         |
| --------- | --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| **CC9.1** | Identifies, selects, develops risk mitigation activities for business disruptions | 🟡     | Backup design exists. DR drill pending.                                                          |
| **CC9.2** | Assesses and manages risk associated with vendors and business partners           | 🟡     | BuzzPay / Pixie / MiCamp / Postgres / Redis / Vercel etc. Vendor inventory + DPA review pending. |

---

## Confidentiality Criteria

| Criterion                                                                     | Control | Status                                                                                               | Evidence |
| ----------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | -------- |
| **C1.1** Identifies and maintains confidential information to meet objectives | ✅      | `DATA_CLASSIFICATION.md` enumerates every field with classification + retention.                     |
| **C1.2** Disposes of confidential information to meet objectives              | 🟡      | Soft-delete on `User`, `Partner`. Hard-delete + cryptoshred on PII pending lifecycle implementation. |

---

## Privacy Criteria (relevant subset)

| Criterion                          | Control                               | Status                                                                                                                                             | Evidence |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **P1** Notice and communication    | ⏳                                    | Customer-facing privacy notice required before connecting real BuzzPay tenant data.                                                                |
| **P2** Choice and consent          | n/a (we don't collect — partner does) | Consent is collected upstream by Pixie smart-form on the partner's site.                                                                           |
| **P3** Collection                  | ✅                                    | Only the fields enumerated in `DATA_CLASSIFICATION.md` are collected, via signed webhook from BuzzPay.                                             |
| **P4** Use, retention, disposal    | 🟡                                    | Use restricted by RBAC. Retention policy documented; sweep job pending.                                                                            |
| **P5** Access                      | ✅                                    | Operators access PII only via the audit-logged `Reveal` flow on `/customers/:hash` or `/applications/:id`. Every reveal writes `PII_ACCESSED` row. |
| **P6** Disclosure to third parties | n/a                                   | We do not share PII downstream.                                                                                                                    |
| **P7** Quality                     | n/a                                   | Source of truth is upstream (BuzzPay). We re-receive on every application.                                                                         |
| **P8** Monitoring and enforcement  | 🟡                                    | PII access dashboard at `/audit/pii`. Anomaly detection (e.g. operator pulls 100 records in 10 min) pending.                                       |

See `PRIVACY.md` for the full Australian Privacy Principles + GDPR alignment.

---

## Specific Implementation References

For an auditor, here is the line-of-code traceability:

| Control claim                                                                    | Code reference                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Password hashing argon2id                                                        | `apps/api/src/shared/utils/password.ts`                                              |
| AES-256-GCM PII envelope w/ key versioning                                       | `apps/api/src/shared/utils/encryption.ts`                                            |
| HMAC SHA-256 webhook signature + 5-min timestamp window + idempotency-key dedupe | `apps/api/src/shared/middleware/webhook-signature.middleware.ts`                     |
| Refresh token rotation + family-wide revoke on reuse                             | `apps/api/src/domains/auth/auth.service.ts` (`refresh()`)                            |
| RBAC enforcement                                                                 | `apps/api/src/shared/middleware/rbac.middleware.ts`                                  |
| CSRF double-submit                                                               | `apps/api/src/shared/middleware/csrf.middleware.ts`                                  |
| Composite IP+email login rate limit                                              | `apps/api/src/shared/middleware/rate-limit.middleware.ts` (used in `auth.routes.ts`) |
| Audit log writer                                                                 | `apps/api/src/shared/middleware/audit-log.middleware.ts`                             |
| Append-only ledger (REVOKE UPDATE/DELETE at role level)                          | `apps/api/prisma/init-timescale.sql`                                                 |
| PII redaction in logs                                                            | `apps/api/src/config/logger.ts` `PII_REDACT_PATHS`                                   |
| Cookie flags (httpOnly + Secure + SameSite=Strict)                               | `apps/api/src/shared/utils/cookies.ts`                                               |
| Helmet + CORS + rate-limit registration                                          | `apps/api/src/server.ts`                                                             |

---

## What an auditor will ask for that we don't yet have

1. **External penetration test report** — schedule before Type 1 fieldwork
2. **Internal vulnerability scans** — automate via `pnpm audit` + Dependabot in CI
3. **Access review evidence** — quarterly review log; first review at first quarter post-launch
4. **Backup restoration test evidence** — quarterly; first test at production deploy
5. **Security awareness training records** — annual; first cycle at first hire
6. **Vendor SOC 2 reports** — collect from Postgres/Redis providers, deployment platform, etc.
7. **Termination procedures** — process doc + runbook; required at first hire
8. **Change advisory board minutes** — for now PR approvals + ADRs; formalise at team scale
9. **Risk register** — partial (STRIDE in `SECURITY.md`); needs annual review cadence
10. **Business continuity / disaster recovery plan** — DR drills + runbook

These map cleanly to the next sprint's compliance work and aren't blockers for engineering handover.

---

## Auditor-friendly summary

We've architected the system so that **every control is a code path**, not a process step. The codebase intentionally shrinks the human-discretion surface:

- A developer cannot accidentally log PII (Pino redaction).
- A developer cannot accidentally write to the audit log without an actor (Zod-typed `writeAuditLog` always extracts `userId` from request context or system tag).
- A developer cannot accidentally update or delete a ledger row (database role permissions).
- A consumer of the API cannot reach data outside their RBAC scope (server-side schema projection).
- A webhook cannot replay (idempotency-key SETNX in Redis with 24h TTL).
- A leaked refresh token cannot be silently used twice (theft detection).

The work to reach Type 1 readiness is mostly **process and evidence collection**, not architecture. Type 2 then needs the evidence loop running for ≥3 months.

---

## Appendix A — Ingestion control surface (added 2026-05-07)

Every data point that backs a financial number in the platform has an explicit, audited write contract. There are exactly three ways data enters the ledger:

| Channel                                | Auth                                | Idempotency                         | Audit action                                                                      |
| -------------------------------------- | ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| Vendor webhook (`/webhooks/...`)       | HMAC SHA-256 + ts tolerance + nonce | Redis SETNX + Postgres unique       | `WEBHOOK_RECEIVED` → `WEBHOOK_PROCESSED` / `WEBHOOK_FAILED` / `WEBHOOK_REPLAYED`  |
| Generic ingestion (`/ingestion/...`)   | Cookie OR PAT bearer + WRITE scope  | `Idempotency-Key` header (required) | `INGESTION_REQUEST` / `INGESTION_REJECTED`                                        |
| Portfolio ingestion (`/portfolio/...`) | Cookie OR PAT bearer + ADMIN scope  | Slug-based upsert                   | `PORTFOLIO_DATA_INGESTED` / `PORTFOLIO_BUSINESS_*` / `PORTFOLIO_VERTICAL_CREATED` |

**Why this matters for SOC 2 (CC6.1, CC6.6, CC7.3, CC8.1):** every state change to a financial figure is traceable to an authenticated principal, an idempotency key, and an audit row. The control matrix is exhaustive — there is no fourth write path.

**PAT scope enforcement (`requireScope`):** added a single authorization gate that resolves the request's effective scope from whichever channel produced `req.auth` (cookie role → derived scope, PAT bearer → token's `scopes` column). Same code path for browser users and ETL workers, no role drift between auth modes.

**Liveness/readiness probes (`/health/live`, `/health/ready`):** A1.2 (availability) — explicit endpoints so orchestrators can decide when to restart vs when to drain traffic, rather than relying on the catch-all `/health` for both.

## Appendix B — Plugging in a new data source

For each source, the answer is "POST to one of seven typed endpoints or the generic `/ingestion/events`." See [INGESTION.md](../INGESTION.md) for the dev contract — Idempotency-Key requirements, Zod schemas per data point, bulk-batch shape, and replay semantics.

---

## Appendix C — Scale & resilience hardening (added 2026-05-07)

Pass-the-pen-test pass. Each change made a specific control evidenceable.

### Database (A1.1, A1.2, CC7.2)

- **Writer / reader split** in `apps/api/src/config/database.ts`. `getPrismaWriter()` is the primary; `getPrismaReader()` routes to the replica when `DATABASE_REPLICA_URL` is set, transparently falls back to writer if the replica is unavailable. Soft-failure mode is "primary handles both."
- **Reader is wired into the actual hot read paths**, not just exposed in config:
  - `apps/api/src/domains/analytics/analytics.routes.ts` (all `/analytics/*`)
  - `apps/api/src/domains/customers/customer.routes.ts` (customer book, stats)
  - `apps/api/src/domains/admin/admin.routes.ts` (audit log views, webhook event lists)
  - `apps/api/src/domains/lenders/lender.routes.ts` (waterfall, performance)
  - `apps/api/src/domains/revenue/revenue.routes.ts` (ledger reads, by-stream/by-partner)
  - `apps/api/src/domains/search/search.routes.ts` (search GET; saved-views CRUD on writer)
- **Read-after-write hazards explicitly handled**: `saved-views` DELETE reads ownership against the writer (not the replica) to avoid the rare race where the replica hasn't caught up to a recent create from the same user. Pattern documented inline.
- **Replication lag exposed in `/health/ready`** via `pg_last_xact_replay_timestamp()`. Lag > 30s flags `replica: degraded` without failing readiness (the platform stays available because reads fall back to writer). Surfaces in `replicaLagMs` for ops dashboards.
- **Role-level connection safety** in `init-timescale.sql`. The `eazepay_app` role inherits `statement_timeout=30s`, `idle_in_transaction_session_timeout=10s`, `lock_timeout=5s`. Application code cannot opt out — every connection inherits these.
- **Slow-query log** via Prisma `$on('query')`. Anything ≥ `DATABASE_SLOW_QUERY_LOG_MS` (default 500ms) emits at WARN with full query text. Pipe to your log aggregator; alert on sustained increases.
- **Connection pool bound** via `DATABASE_URL?connection_limit=N`. Documented sizing: total ≤ Postgres `max_connections − 20%`. PgBouncer is the path forward when totals exceed.

### Rate limits (CC6.1, A1.1)

Tiered with environment-driven defaults; see [`docs/COMPUTE_LIMITS.md`](../COMPUTE_LIMITS.md).

- **Anonymous**: 100/min by `req.ip` — strict floor
- **Authenticated**: 1,000/min by `auth.userId` — per-user, not per-IP (NAT-safe)
- **Ingestion**: 6,000/min — sized for sustained 100/sec ETL
- **Webhook ingress**: 10,000/min — accommodates vendor retry storms
- **Login**: composite per-IP + per-email (5/15min + 10/15min)

Redis-backed buckets are cluster-wide. **Fail closed** on Redis outage — that's the correct SOC 2 posture. Per-route bucket overrides via `config: { rateLimit: { … } }`.

### Body limits (CC6.1, A1.1)

Per-route via Fastify `routeOptions.bodyLimit`:

- Default: 1 MiB
- Bulk ingestion: 8 MiB (caps memory pressure during backfill)
- Webhook ingress: 2 MiB

### Worker concurrency (CC7.2, A1.1)

Env-driven (`WORKER_*_CONCURRENCY`) so we tune per pod size without code changes. BullMQ fan-out is non-overlapping by construction (Redis-keyed queues), so scaling is "more replicas of the same worker process" — linear.

### Graceful shutdown (A1.2, CC7.5)

Re-entrant guard + 30-second hard timeout in `apps/api/src/index.ts`. Order: stop accepting → drain in-flight (Fastify `app.close()`) → disconnect Prisma → disconnect Redis. Hard exit if drain takes >30s, so we don't hang an orchestrator restart forever.

### Health probes (A1.2)

`/health/live` (process up, no dep checks) + `/health/ready` (primary + Redis required, replica soft-checked) + `/health` (full status with latencies). Orchestrators (K8s, ECS) decide restart vs drain based on the probe choice.

### Failure-mode coverage

Every external dependency (DB primary, DB replica, Redis, vendor webhook subscriber HTTP) has a documented failure mode + mitigation in `COMPUTE_LIMITS.md`. The platform fails closed on Redis outage, soft-degrades on replica failure, and surfaces a meaningful 5xx (not a generic crash) on primary failure.
