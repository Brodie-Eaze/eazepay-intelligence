# Architecture · EazePay Intelligence

**Snapshot:** 2026-05-08 · `feat/portfolio-silos` branch.

For "what's done vs what's not," see [`STATUS.md`](../STATUS.md).
For Trust Services Criteria mapping, see [`docs/governance/SOC2_CONTROLS.md`](governance/SOC2_CONTROLS.md).
For the dev-facing data ingestion contract, see [`docs/INGESTION.md`](INGESTION.md).
For the scale envelope + failure-mode matrix, see [`docs/COMPUTE_LIMITS.md`](COMPUTE_LIMITS.md).

---

## Mission

Two surfaces, one platform:

1. **EazePay observability plane** — read-only ingestion + projection of vendor events from BuzzPay (lender), HighSale's Pixie (pre-qual), and MiCamp (processing). Every event flows through signed webhooks, is persisted to an append-only ledger, and is rendered as a real-time operator dashboard.
2. **Holdco / portfolio plane** — durable persistence for every silo we operate. Verticals → businesses → financial deep-dive (12-line monthly P&L, revenue channels + product lines, unit economics, cohort retention, headcount). The view a PE group or family office expects.

**Read-only by design.** The platform never originates loans, renders decisions, or moves money.

---

## System diagram

```
                         ┌─ Vendors ────────┐
                         │  BuzzPay  ───────┤
                         │  Pixie / HighSale┤
                         │  MiCamp  ────────┤
                         └─────────┬────────┘
                                   │ HMAC SHA-256 + ts tolerance + Idempotency-Key
                                   ▼
                ┌──────────────────────────────────────────────┐
                │ POST /api/v1/webhooks/{source}/{eventType}   │
                │   1. verify signature                        │
                │   2. dedupe via Redis SETNX hot path         │
                │   3. dedupe via Postgres UNIQUE(source, key) │
                │   4. persist WebhookEvent + OutboxEvent (1 tx)│
                │   5. 202 (target p99 < 30 ms)                │
                └────────────────────┬─────────────────────────┘
                                     │
                       ┌──── outbox.worker (FOR UPDATE SKIP LOCKED) ────┐
                       ▼                                                ▼
              BullMQ webhook queue (Redis)            Postgres ledger (durable)
                       │
                       ▼
            webhook.worker → upsert Application / LenderDecision / RevenueEvent
                       │     (with PII encrypt at boundary)
                       │
            publishes WS event ──► Redis pub/sub channel ws:analytics
                                       │
                                       ▼
                       Next.js operator dashboard
                       (ticket-authed WS connection)

Programmatic ingestion (ETL workers, backfills):
  PAT bearer ──► POST /api/v1/ingestion/{applications,lender-decisions,…}
              ──► same Zod schemas as the signed-webhook path
              ──► same WebhookEvent → outbox → worker pipeline

Portfolio (silos):
  ADMIN PAT ──► POST /api/v1/portfolio/businesses/:slug/{pnl,revenue,cohorts,…}
              ──► PortfolioRepository (replace-set, single tx)
              ──► UI surfaces pull straight from these tables

Background:
  alert.worker        — every 30s, evaluate AlertRule.query against the reader, fire/dispatch/audit
  lifecycle.worker    — every 5m, scrub webhook payloads >90d, purge expired refresh tokens, drain RTBF
  aggregation.worker  — on enqueue, materializes RevenueAggregation rows
  webhook-delivery.worker — drains outbound webhook subscriptions with HMAC + retry
```

---

## Process topology

| Process                   | Run as                                      | Notes                                                         |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `apps/api`                | `pnpm --filter api dev` / `start`           | Fastify HTTP + WS gateway                                     |
| `worker:webhook`          | `pnpm --filter api worker:webhook`          | Drains the BullMQ webhook queue → ledger writes               |
| `worker:webhook-delivery` | `pnpm --filter api worker:webhook-delivery` | Outbound webhook fanout with HMAC + exp-backoff retry         |
| `worker:outbox`           | `pnpm --filter api worker:outbox`           | Sweeps `outbox_events WHERE published_at IS NULL` to BullMQ   |
| `worker:aggregation`      | `pnpm --filter api worker:aggregation`      | Materializes `RevenueAggregation` rollups                     |
| `worker:revenue`          | `pnpm --filter api worker:revenue`          | Period-close projections                                      |
| `worker:export`           | `pnpm --filter api worker:export`           | Async export jobs (CSV/JSON/XLSX)                             |
| `worker:alert`            | `pnpm --filter api worker:alert`            | 30s poll, evaluates rules, fires + dispatches + auto-resolves |
| `worker:lifecycle`        | `pnpm --filter api worker:lifecycle`        | 5m poll, retention scrubs + RTBF processor                    |

Each worker carries its own OTEL service name (`eazepay-intelligence-worker-{name}`) so trace dashboards split per process.

---

## Domain layout

```
apps/api/src/
├── config/
│   ├── env.ts          # Zod-validated env, fails boot on invalid config
│   ├── logger.ts       # Pino with PII redaction
│   ├── database.ts     # writer / reader / long Prisma clients + reader write-block guard
│   ├── redis.ts        # ioredis singleton + pub/sub publishers
│   └── telemetry.ts    # OpenTelemetry SDK init (no-op when OTEL_ENABLED=false)
│
├── domains/
│   ├── alerts/         # rule store, evaluator (Zod DSL), dispatcher, state machine
│   ├── analytics/      # dashboard hot path (Redis-cached, KPI assembly)
│   ├── api-tokens/     # PAT issuance, revoke, scopes (READ/WRITE/ADMIN)
│   ├── applications/   # webhook-ingested apps + audit-logged PII reveal
│   ├── auth/           # cookie session, MFA (TOTP), WS-ticket issuer, scope toggle
│   ├── customers/      # deduped-by-email-hash customer book + financial profile
│   ├── exports/        # async CSV/JSON/XLSX exports
│   ├── fx/             # multi-currency rate table + service (same/direct/inverse/triangulate)
│   ├── ingestion/      # generic /ingestion/* contract for ETL / backfills
│   ├── lenders/        # waterfall analytics + per-lender deep-dive
│   ├── notes/          # cross-resource notes
│   ├── outbound-webhooks/  # subscriber CRUD + delivery worker
│   ├── partners/       # partner CRUD + RBAC
│   ├── pixie/          # HighSale usage + sliding-scale margin
│   ├── portfolio/      # holdco view: verticals, businesses, P&L, cohorts, headcount
│   ├── revenue/        # ledger projection + clawback view
│   ├── rtbf/           # right-to-be-forgotten cryptoshred
│   ├── scheduled-reports/  # cron-style report runs
│   ├── search/         # cross-domain search + saved views
│   ├── tags/           # label store + assignments
│   ├── users/          # user CRUD + role + MFA + sessions
│   └── webhooks/       # signed-webhook ingress (BuzzPay/Pixie/MiCamp)
│
├── shared/
│   ├── errors/         # AppError + factory functions (errors.notFound, errors.unauthorized…)
│   ├── middleware/
│   │   ├── auth.middleware.ts          # cookie session validation
│   │   ├── bearer-auth.middleware.ts   # PAT bearer + requireCookieOrBearer
│   │   ├── csrf.middleware.ts          # double-submit token guard
│   │   ├── rbac.middleware.ts          # requireRole + denyInvestorScope
│   │   ├── scope.middleware.ts         # requireScope (cookie role ⇄ PAT scope)
│   │   ├── webhook-signature.middleware.ts # HMAC + ts skew + idempotency
│   │   ├── audit-log.middleware.ts     # writeAuditLog helper + AuditAction union
│   │   └── rate-limit-tiers.ts         # per-route rate-limit configs
│   ├── queues/         # BullMQ queue declarations + job types
│   └── utils/          # encryption (AES-GCM + HMAC), api-token, jwt, ws-publisher,
│                       # outbox.appendToOutbox, tracing.withSpan
│
├── workers/            # 8 worker entry points, telemetry-wired as first import
├── websocket/          # WS gateway + Redis pub/sub fanout + scope filtering
├── server.ts           # Fastify factory: plugins → decimal serializer → error handler → routes
└── index.ts            # production entry: telemetry → buildServer → listen → graceful shutdown
```

Per-domain layout: every domain follows `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts`. Prisma calls live in `*.repository.ts` (or directly in routes for trivial reads).

---

## Data model — append-only spine

```
                        Partner
                         │
                         │ 1..n
                         ▼
                    Application ──── consumer_email_hash (HMAC-SHA-256)
                         │           consumer_*_ciphertext (AES-256-GCM, version-prefixed)
                         │ 1..n
                         ▼
                    LenderDecision ── external_decision_id UNIQUE
                         │
                         │ 1..n
                         ▼
                    RevenueEvent ── @@id([effectiveAt, partnerId, idempotencyKey])
                                    @@unique([source, idempotencyKey])
                                    APPEND-ONLY (UPDATE/DELETE revoked at role level)

  WebhookEvent ── @@unique([source, idempotencyKey])
                  signatureValid: bool, payload: Json, status enum
                  payload scrubbed at 90d by lifecycle.worker

  OutboxEvent ── kind enum (WEBHOOK_INBOUND / OUTBOUND_DELIVERY / WS_EVENT)
                 published_at NULL until sweeper drains

  AuditLog ── action enum (50+ values), userId, resource ref, metadata, ip, ua
              APPEND-ONLY (UPDATE/DELETE revoked at role level)

  RtbfRequest ── (emailHash, status) → cryptoshred Application PII rows in one tx

  FxRate ── @@unique([asOf, baseCurrency, quoteCurrency])
            FxService picks at-or-before with direct/inverse/triangulate fallthrough

  Portfolio* ── 8 tables, durable persistence for the silos surface
```

The append-only invariant on `audit_logs`, `revenue_events`, and `outbox_events` is enforced at the Postgres role level — `init-timescale.sql` runs `REVOKE UPDATE, DELETE ON … FROM eazepay_app`. The runtime role cannot bypass it; only `eazepay_owner` (migration role) can.

---

## Multi-database architecture

Three Prisma client singletons backed by different connection URLs. All defined in `apps/api/src/config/database.ts`.

| Client              | Env var                | Role                  | Use case                                                      |
| ------------------- | ---------------------- | --------------------- | ------------------------------------------------------------- |
| `getPrismaWriter()` | `DATABASE_URL`         | `eazepay_app`         | Mutations + read-after-write reads + transactions             |
| `getPrismaReader()` | `DATABASE_REPLICA_URL` | `eazepay_app` replica | Lag-tolerant heavy reads (analytics, dashboards, audit views) |
| `getPrismaLong()`   | `DATABASE_LONG_URL`    | `eazepay_worker_long` | Export + aggregation worker reads (5-min `statement_timeout`) |

**Transparent fallback** — if `DATABASE_REPLICA_URL` is unset, `getPrismaReader()` returns the writer instance. `isReaderUsingFallback()` introspection lets `/health/ready` surface the state.

**Reader runtime guard** — a Prisma `$use` middleware on the reader client refuses every mutating action (`create / createMany / update / updateMany / upsert / delete / deleteMany / executeRaw / executeRawUnsafe`) and throws `prisma.reader.write_blocked` with the model + action. Defense in depth above Postgres's "cannot execute … in a read-only transaction" error.

**Replication lag** — `/health/ready` runs `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms` against the replica. Lag >30s flags `replica: degraded` without failing readiness (the platform stays available because the reader transparently falls back).

**Live integration tests** — `docker-compose.test.yml` boots a primary + a streaming replica via `pg_basebackup -R` + `replica_1` slot. `scripts/test-integration-db.sh` runs the live suite, verifies replication round-trip + reader middleware refusal + lag query semantics.

Routes pinned to the reader: `/analytics/*`, `/customers/*`, `/audit-logs`, `/admin/webhook-events*`, `/lenders/*`, `/revenue/*`, `/search` GET, `/applications/*` GET. All other routes use the writer.

---

## Authentication + authorization

### Cookie session (browser)

```
POST /auth/login (email, password, mfaCode?)
  argon2id verify → optional TOTP verify → issue access JWT (HS256, 15min) +
  refresh token (HMAC-SHA-256-keyed, 7d, family-tracked) +
  CSRF token (signed) → all in httpOnly + Secure + SameSite=Strict cookies
```

**Refresh-token theft detection:** every refresh issues a new raw token, marks the old `revokedAt = now()`, sets `replacedBy`, persists family id. Reuse of an already-revoked token in the family triggers a **family-wide revoke** (catches token theft).

### PAT bearer (programmatic)

```
Authorization: Bearer epi_pk_<8-byte prefix>_<24-byte secret>
  → split into prefix + secret
  → look up by prefix (indexed)
  → constant-time compare hashed-secret
  → check revokedAt + expiresAt
  → bump lastUsedAt (best-effort)
```

PAT format `epi_pk_<prefix>_<secret>`; we store the prefix + sha256 of the secret. The full token is shown once at creation.

### Unified scope check

`requireScope('READ' | 'WRITE' | 'ADMIN')` resolves the request's effective scope from whichever channel produced `req.auth`:

- Cookie path → derived from `User.role` (ADMIN ⊇ WRITE ⊇ READ; OPERATOR ⊇ WRITE; INVESTOR/VIEWER = READ)
- PAT path → `ApiToken.scopes` column; ADMIN implies WRITE+READ, WRITE implies READ

Enables the same handler to be called from the dashboard (cookie) and an ETL worker (PAT) without different code paths.

### CSRF

Double-submit token: `epi_csrf` cookie (NOT httpOnly, signed) + `X-CSRF-Token` header (mirror). Server verifies cookieEqualsHeader && hmacValid on every cookie-authed mutation. PAT bearer requests skip CSRF (same-origin doesn't apply).

### WebSocket auth

```
POST /auth/ws/ticket  (cookie + CSRF authed)
  → ticketId = uuid, stored in Redis at ws:ticket:<id> with 30s TTL
  → returns { ticket, expiresInSeconds }
WS /ws/analytics?ticket=…
  → server: GETDEL ws:ticket:<id> → upgrade if found
```

Single-use, 30-second tickets prevent token theft via WS handshake URL leakage.

---

## Webhook ingestion pipeline

Per inbound webhook:

1. **Header presence** — signature, timestamp, idempotency-key (Fastify rejects with 401 if any missing).
2. **Timestamp tolerance** — ±300s skew check.
3. **Signature** — constant-time HMAC SHA-256 over `${ts}.${rawBody}` with per-source secret.
4. **Idempotency layer 1** — Redis SETNX `idem:{source}:{key}` with 24h TTL. Hit returns the cached 202 body.
5. **Idempotency layer 2** — Postgres `webhookEvent.findUnique({ source, idempotencyKey })`. Outlives Redis TTL/eviction.
6. **First-time event** — `WebhookEvent.create` durably + `OutboxEvent.create` in the **same transaction** + 202 to caller.
7. **Outbox sweeper** picks up the row via `FOR UPDATE SKIP LOCKED`, enqueues to BullMQ, marks `published_at`.
8. **Webhook worker** consumes, processes the event in a transaction, writes ledger rows, publishes WS event.

The two-phase-commit between DB and BullMQ is closed by the outbox pattern. If the API process dies between DB commit and BullMQ enqueue, the row is recovered on the next sweeper poll (≤1s).

For the dev-facing programmatic ingestion contract (PAT-authenticated, same Zod schemas, no HMAC required), see [`docs/INGESTION.md`](INGESTION.md).

---

## Alert engine

`AlertRule.query` is a **closed declarative DSL** — Zod discriminated union over a finite set of metrics. No arbitrary SQL: a misconfigured rule cannot exfiltrate or modify data.

```typescript
type RuleQuery =
  | { metric: 'webhook_failure_rate';  op: 'gt'|'gte'|'lt'|'lte'; value: number }
  | { metric: 'webhook_event_count';   source?: 'BUZZPAY'|'PIXIE'|'MICAMP'; op: …; value: number }
  | { metric: 'failed_login_count';    op: …; value: number }
  | { metric: 'application_count';     status?: ApplicationStatus; op: …; value: number }
  | { metric: 'revenue_amount';        stream?: 'BUZZPAY'|'PIXIE'|'MICAMP'; op: …; value: number }
  | { metric: 'pii_access_count';      op: …; value: number }
  | { metric: 'ingestion_rejected_count'; op: …; value: number }
  | { metric: 'replication_lag_ms';    op: …; value: number };
```

Each metric maps to an indexed query against the read replica with `windowMinutes` as lookback.

`alert.worker` polls every 30s (env `ALERT_POLL_INTERVAL_MS`):

- **Per-rule cadence floor** — re-eval no more often than `windowMinutes / 2`. Tracked at Redis key `alert:last:<id>`. Stops a 60-min rule double-firing from a 30s poll.
- **Cross-replica lock** — SETNX `alert:lock:<id>` so multiple worker replicas don't stampede.
- **State machine:**
  - `HIT && no open` → create OPEN Alert + dispatch via channel
  - `HIT && open exists` → no-op (no double-fire)
  - `COOL && open exists` → mark RESOLVED + audit `ALERT_RESOLVED`
  - `COOL && no open` → no-op
- **Dispatcher** — `IN_APP` (Alert row IS the surface), `WEBHOOK` (queued for delivery via outbound subscription), `EMAIL` / `SLACK` (stubbed; vendor integration pending).
- Every fire writes `ALERT_FIRED` to audit_log.

---

## Right-to-be-forgotten + lifecycle

`POST /admin/rtbf` submits a request with the consumer's email hash. The lifecycle worker's RTBF processor:

1. Marks the request `PROCESSING` (timestamps `startedAt`).
2. Finds every Application carrying that `consumerEmailHash`.
3. In a single transaction, overwrites these encrypted columns with `Buffer.alloc(32, 0)`:
   - `consumerNameCiphertext`
   - `consumerEmailCiphertext`
   - `consumerPhoneCiphertext`
   - `consumerEmailHash`
   - `consumerPhoneHash`
4. Stamps the request `COMPLETED` with `applicationsScrubbed` count.
5. Writes `RTBF_PROCESSED` to audit_log.

**Why scrub instead of delete:** LenderDecision and RevenueEvent reference Application; a hard delete would orphan financial records that have a 7-year regulatory retention. AES-GCM IV+tag are part of the ciphertext bytes — zeroing the columns makes the data cryptographically unrecoverable even with the master key. The financial trail survives, the data subject's PII does not.

The lifecycle worker also runs:

- **Webhook payload scrub** at 90 days (clears `webhook_events.payload`, keeps row + metadata for audit)
- **Refresh-token purge** at 30 days post-expiry/revoke

---

## Multi-currency

`RevenueEvent.currency` (ISO-4217 alpha-3) — defaults to `USD`, respects vendor `currency` field when emitted.

`FxRate` model: `(asOf, baseCurrency, quoteCurrency)` unique, indexed `(base, quote, asOf DESC)` for at-or-before lookup.

`FxService.convert(amount, from, to, asOf)` lookup falls through:

1. Same currency → identity
2. Direct rate (`base, quote`)
3. Inverse rate (`quote, base` → `1/x`)
4. Triangulate via `REPORTING_CURRENCY` pivot (`from→reporting * reporting→quote`)
5. Throw `errors.badRequest` (silent drop would corrupt rollups)

Per-day in-process LRU cache, 1h TTL, bounded at 5k entries.

Admin endpoints for pushing rates:

- `POST /admin/fx-rates`
- `POST /admin/fx-rates/bulk` (up to 1000 rows)
- `GET /admin/fx-rates`

Audit action `FX_RATE_INGESTED` on every push.

---

## Observability

### Logs

Pino structured JSON, request-correlated by `requestId` (UUIDv7 generated per request, surfaced in `X-Request-Id` header). PII paths redacted at the logger level — `*.consumerName`, `*.consumerEmail`, `*.consumerPhone`, `*.passwordHash`, `*.password`, `*.mfaSecret`, `*.tokenHash`, …

### Metrics

`GET /metrics` returns Prometheus text format aggregated from every Prisma client (writer + reader + long), namespaced by `db` label so dashboards can split primary vs replica vs long pool pressure.

Examples:

- `prisma_pool_connections_busy{db="writer"}`
- `prisma_client_queries_duration_histogram_ms_bucket{db="reader"}`
- `prisma_pool_connections_open_current{db="long"}`

### Traces

OpenTelemetry NodeSDK with auto-instrumentation across HTTP (`http`), Postgres (`pg`), Redis (`ioredis`), Fastify, and BullMQ. Off by default (`OTEL_ENABLED=false`); zero overhead in dev/test.

W3C `traceparent` propagation across HTTP and BullMQ jobs — a webhook ingress trace flows through the outbox sweeper, fan-out worker, and delivery attempt as one continuous trace.

`withSpan(name, fn)` helper for business-operation spans. Wired into `alert.evaluate` (records metric, op, threshold, observed, hit) and `rtbf.process` (records request id + applications scrubbed). Falls back to no-op tracer when SDK isn't started.

OTLP/HTTP exporter — vendor-neutral, accepts Datadog / Honeycomb / NewRelic / Grafana Tempo / Jaeger.

### Health probes

- `/health` — full status + dependency latencies. Default ops dashboard.
- `/health/live` — process up; no dep checks. Liveness probe target.
- `/health/ready` — primary + Redis required, replica soft-checked, `replicaLagMs` surfaced. Readiness probe target.

---

## Compute limits + scale envelope

Full breakdown in [`docs/COMPUTE_LIMITS.md`](COMPUTE_LIMITS.md). Headline:

| Tier                       | Default limit      | Bucket key    |
| -------------------------- | ------------------ | ------------- |
| Anonymous                  | 100/min            | `req.ip`      |
| Authenticated default      | 1,000/min          | `auth.userId` |
| Ingestion (`/ingestion/*`) | 6,000/min          | `auth.userId` |
| Webhook ingress            | 10,000/min         | source IP     |
| Login (composite)          | 5/15min + 10/15min | IP + email    |

Buckets are Redis-backed → cluster-wide. Fail closed on Redis outage.

Per-route body limits: 1 MiB default / 8 MiB bulk ingestion / 2 MiB webhook ingress.

Worker concurrency env-driven: `WORKER_WEBHOOK_CONCURRENCY=10`, `WORKER_DELIVERY_CONCURRENCY=20`, `WORKER_OUTBOX_BATCH=100`.

Role-level Postgres timeouts on `eazepay_app`: `statement_timeout=30s`, `idle_in_transaction_session_timeout=10s`, `lock_timeout=5s`. The long-running role `eazepay_worker_long` gets `statement_timeout=5min`.

---

## Architectural Decision Records

### ADR-001 — Modular monolith

Single Node process serves the API; 8 worker processes run separately. Domain boundaries enforced at the source-tree level so any domain can be extracted to its own service when scale demands.
**Trade-off:** zero microservice ceremony today; clean extraction path later.

### ADR-002 — TimescaleDB hypertables for metric tables

`pixie_metrics`, `revenue_aggregations`, `revenue_events` are hypertables (chunked by 7-30 days). Continuous aggregate `revenue_daily_cagg` powers sub-100ms revenue queries even over multi-year ranges.

### ADR-003 — PII encrypted at rest with key versioning

AES-256-GCM envelopes prefixed with a 1-byte key-version tag. Searchable lookup via deterministic HMAC-SHA-256 hash with separate `PII_HASH_SECRET` pepper. Decryption is service-mediated — every call audit-logged.
**Trade-off:** equality lookup only (no partial / fuzzy match on encrypted columns).

### ADR-004 — BullMQ over native Postgres queues

BullMQ on Redis gives us delayed/retry/exponential-backoff for free, plus excellent observability. We already need Redis for caching, pub/sub, rate-limiting, and idempotency.

### ADR-005 — Fastify over Express

Native TypeScript types, plugin lifecycle, schema-validation hooks, lower per-request overhead. Plugin order locked in `server.ts` — helmet → cors → sensible → rate-limit → websocket → routes.

### ADR-006 — Inferred webhook payload contracts

Until partner integration docs land, we maintain Zod schemas for what we _expect_. Versioned in `webhook.schemas.ts`; trigger 422 on contract drift. HMAC + idempotency layer remains correct even if payload shapes shift.

### ADR-007 — Turborepo

`turbo.json` declares `build / typecheck / lint / test` pipelines with topological deps. Local + CI both run the same graph.

### ADR-008 — OpenAPI as single source of truth (planned)

`@asteasolutions/zod-to-openapi` will emit OpenAPI 3.1 directly from Zod schemas; `openapi-typescript` consumes that into `packages/shared-types/src/api.ts`. **Not yet wired** — see ROADMAP.md.

### ADR-009 — Read-only observability plane (no origination)

Public mutation surface is narrow: auth, partner onboarding, user admin, ingestion endpoints. All financial state changes arrive via signed webhooks or PAT-authenticated ingestion. PII can be viewed by operators with audit logging — never used to drive any action from this system.

### ADR-010 — Cookie session + PAT bearer + WS ticket

Three auth channels, one authorization gate (`requireScope`).

### ADR-011 — Append-only RevenueEvent ledger

Every dollar shown on a dashboard projects from `revenue_events`. Inserted by the webhook worker, never updated, never deleted (REVOKE at role level). Clawbacks/reversals are _new_ negative-amount rows. Investor revenue numbers reconcile to a journal.

### ADR-012 — Single typeface, navy + light-blue palette

Inter throughout, including for numbers (tabular figures via `tnum` font feature). Palette: navy ink, paper background, accent blue, light blue. Status pills use blue + slate variations — no traffic-light green/amber/red.

### ADR-013 — Outbox pattern for webhook ingress

Closes the two-phase-commit window between DB write and BullMQ enqueue. If the API process dies between commits, the outbox sweeper recovers on its next poll (≤1s). At-least-once delivery; downstream consumers idempotent on `(source, idempotency_key)`.

### ADR-014 — Generic ingestion contract

A second ingestion surface under `/api/v1/ingestion/*` accepts the same Zod-validated payloads as the signed-webhook path, authenticated via PAT bearer instead of HMAC. Same pipeline (WebhookEvent → outbox → worker), same audit trail, same idempotency. Lets ETL workers and partner backfills push data without minting per-vendor secrets.

### ADR-015 — Multi-database writer/reader/long with runtime guard

Three Prisma client singletons. Read-only routes use the reader (replica when configured); writes use the writer; long-running worker reads use a separate role with a 5-min `statement_timeout`. A Prisma `$use` middleware on the reader client refuses every mutating action — defense in depth above Postgres's "read-only transaction" rejection.

### ADR-016 — Closed-DSL alert engine

Rule queries are a Zod discriminated union, not arbitrary SQL. Adding a metric is one entry in the union plus a handler. No path from a rule editor to a destructive query.

### ADR-017 — Cryptoshred RTBF (don't delete the row)

GDPR Art. 17 / APP 12 erasure runs as: overwrite the encrypted PII columns with zero buffers in a single transaction. The row stays so financial references aren't orphaned (LenderDecision + RevenueEvent reference Application; 7-year retention). AES-GCM IV+tag are part of the ciphertext bytes; zeroing makes the data cryptographically unrecoverable even with the master key.

### ADR-018 — OpenTelemetry as the trace bus, vendor-neutral OTLP exporter

OTEL SDK auto-instruments HTTP, pg, ioredis, Fastify, BullMQ. Vendor-neutral OTLP/HTTP exporter accepts Datadog / Honeycomb / NewRelic / Grafana Tempo / Jaeger. SDK is the very first import in every entry point so auto-instrumentation can hook `require()` before any other module loads.

---

## Architectural invariants

Enforced via code review on every PR:

1. **No Prisma calls outside `*.repository.ts`** (or trivial route reads). Services accept repo interfaces via constructor.
2. **No `any`. No bare `as` casts** outside Zod boundaries.
3. **Every route handler:** Zod-parse → service call → response envelope. ≤30 lines.
4. **Every mutation:** wrapped in transaction + emits audit log row.
5. **PII fields** routed through `shared/utils/encryption.ts` AES-256-GCM helper. Plaintext never touches Prisma.
6. **Webhook handlers** are write-only to the outbox. Processing happens in workers — keeps p99 ingest latency flat under burst.
7. **Money never crosses a JS `number`.** Decimal → string at the wire.
8. **Time never crosses a "timezone-unaware string".** UTC ISO end-to-end.
9. **Reader vs writer:** analytics + dashboard reads use `getPrismaReader()`; writes use `getPrismaWriter()`. The reader has a runtime guard.
10. **Append-only tables** (`audit_logs`, `revenue_events`, `outbox_events`) — UPDATE/DELETE revoked at the runtime DB role. Application code cannot bypass.

---

## Performance targets

| Endpoint                      | Target p99 | Strategy                                               |
| ----------------------------- | ---------- | ------------------------------------------------------ |
| `GET /analytics/overview`     | <100 ms    | Redis 30s cache + parallel Prisma + Timescale CAGG     |
| `GET /analytics/revenue` (1y) | <150 ms    | Continuous aggregate, no row-by-row                    |
| `POST /webhooks/*`            | <30 ms     | verify + persist + outbox                              |
| `GET /partners` (page)        | <80 ms     | composite index `(deletedAt, createdAt DESC, id DESC)` |
| WS event fanout               | <50 ms     | Redis pub/sub, no DB round-trip                        |
| `/health/ready`               | <50 ms     | parallel DB + replica + Redis pings                    |

---

## Backups + DR

- Nightly `pg_dump` to S3 (lifecycle: 30d hot, 1y archive)
- 4-hourly WAL archive (RPO ≤ 4h, RTO ≤ 30 min)
- Redis treated as ephemeral cache + queue — no separate backup; queue durability handled by BullMQ rehydrating from Postgres outbox on restart

**Restore drill:** documented in `docs/RUNBOOK.md`; first execution is a P1 ROADMAP item before SOC 2 fieldwork.

---

## Deployment topology

**Today (dev):** docker-compose with `postgres` (TimescaleDB image) + `redis`, plus `apps/api` and `apps/web` running natively via `pnpm dev`.

**v1 (single host):** docker-compose with `api`, `worker.webhook`, `worker.webhook-delivery`, `worker.outbox`, `worker.aggregation`, `worker.alert`, `worker.lifecycle`, `web` behind same TLS termination.

**v1.1 (managed):** target Fly / Railway / AWS ECS / GCP — TBD pending deploy decision (ROADMAP P1).

**Multi-region + DR:** ROADMAP P4.

---

## Testing strategy

- **Unit (vitest)** — 88 passing. Covers encryption, JWT, outbox helper, Pixie margin, partner labels, multi-DB factory, reader write-block, alert engine, lifecycle + RTBF, FX service, telemetry init, portfolio repository.
- **Live integration (docker-compose primary + replica)** — 6 tests via `scripts/test-integration-db.sh`. Covers replication round-trip, reader middleware refusal, Postgres engine-level read-only refusal, lag query semantics.
- **E2E (Playwright)** — one spec today (`login-and-overview.spec.ts`); ROADMAP P2 expands.
- **Coverage thresholds** declared in `vitest.config.ts` (80% lines / 75% branches), not yet gating CI.

CI matrix:

- `build` — typecheck + lint + unit tests + build
- `dep-vuln-scan` — `pnpm audit` + Trivy fs scan
- `static-analysis` — CodeQL `security-extended`
- `container-scan` — Trivy image + CycloneDX SBOM artifact
- `integration-multi-db` — runs `scripts/test-integration-db.sh` against fresh primary + replica

All scans upload SARIF to GitHub Code Scanning. SBOM attached as 90-day workflow artifact.
