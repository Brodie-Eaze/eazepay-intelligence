# Architecture · EazePay Intelligence

## Mission

EazePay Intelligence is the **read-only observability and financial-intelligence plane** for the EazePay platform. It ingests events from three product surfaces (BuzzPay lender, HighSale's Pixie pre-qual, MiCamp processing), persists them to an append-only ledger, and projects KPIs into a real-time operator dashboard.

**Read-only by design.** We never originate, decide, or transfer.

---

## System diagram

```
                           ┌─ External products ─┐
                           │  BuzzPay  ──webhook ─┤
                           │  Pixie    ──webhook ─┤
                           │  MiCamp   ──webhook ─┤
                           └─────────────────────┘
                                      │ HMAC SHA-256 + Idempotency-Key
                                      ▼
            ┌──────────────────────────────────────────────────┐
            │   POST /api/v1/webhooks/*                        │
            │   1. verify signature  2. dedupe idempotency-key │
            │   3. persist WebhookEvent  4. enqueue            │
            │   5. 202 Accepted (target p99 < 30 ms)           │
            └──────────────────────────────────────────────────┘
                                      │ BullMQ (Redis)
                                      ▼
            ┌──────────────────────────────────────────────────┐
            │   workers/webhook.worker                         │
            │   process per source/event-type, in transaction  │
            │   appends RevenueEvent rows (immutable ledger)   │
            │   publishes WS event                             │
            └──────────────────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
         PostgreSQL 16          Redis 7 (cache,         WS subscribers
         + TimescaleDB          pub/sub, queue,         (browser dashboards
         (relational +          rate-limit, ws          via ticket auth)
         hypertables)            ticket store)
                                      │
                                      ▼
                   workers/aggregation.worker (cron + on-write)
                   workers/revenue.worker     (period close scheduler)
```

---

## Domain boundaries

```
src/domains/
  auth/         cookie-based session, MFA, WS-ticket issuer, scope toggle
  partners/     onboard / read; the only public CREATE in the system
  applications/ READ-ONLY view of webhook-ingested applications + audit-logged PII reveal
  lenders/      READ-ONLY waterfall analytics + per-lender deep-dive
  webhooks/     ingestion routes + processor service (the only data inlet)
  revenue/      ledger projection + clawback view
  pixie/        HighSale usage + breakpoint status + sliding-scale margin
  analytics/    dashboard hot path (Redis-cached, KPI assembly, live tail)
  customers/    deduped-by-email-hash customer book + financial microscope
  users/        admin user CRUD with role + MFA + sessions
  admin/        webhook events, audit, system health, sessions, reconciliation
```

Each domain follows: `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts`. No exceptions.

---

## Architectural Decision Records

### ADR-001 — Modular monolith

Single Node process serves the API; worker processes peeled off to separate runtime. Domain boundaries enforced at the source-tree level so any domain can be extracted to its own service when scale demands.
**Trade-off:** zero microservice ceremony today; clean extraction path later.

### ADR-002 — TimescaleDB hypertables for metric tables

`pixie_metrics`, `revenue_aggregations`, `revenue_events` are hypertables (chunked by 7-30 days). Continuous aggregate `revenue_daily_cagg` powers sub-100ms revenue queries even over multi-year ranges.
**Trade-off:** small operational burden (Timescale extension required) for >10× analytics performance.

### ADR-003 — PII encrypted at rest with key versioning

AES-256-GCM envelopes prefixed with a 1-byte key-version tag. Searchable lookup via deterministic HMAC-SHA-256 hash with separate `PII_HASH_SECRET` pepper. Decryption is service-mediated — every call audit-logged.
**Trade-off:** equality lookup only (no partial / fuzzy match on encrypted columns). Sufficient for our use-case.

### ADR-004 — BullMQ over native Postgres queues

BullMQ on Redis gives us delayed/retry/exponential-backoff for free, plus excellent observability. Postgres-as-queue (LISTEN/NOTIFY, SKIP LOCKED) was considered but rejected because we already need Redis for caching, pub/sub, rate-limiting, and idempotency.

### ADR-005 — Fastify over Express

Native TypeScript types, plugin lifecycle, schema-validation hooks, lower per-request overhead. Plugin order locked in `server.ts` — helmet → cors → sensible → rate-limit → websocket → routes.

### ADR-006 — Inferred webhook payload contracts

Until partner integration docs land we maintain Zod schemas for what we _expect_: `BuzzpayApplicationWebhookSchema`, `BuzzpayLenderDecisionWebhookSchema`, etc. Versioned in `webhook.schemas.ts`; trigger 422 on contract drift. HMAC + idempotency layer remains correct even if payload shapes shift.

### ADR-007 — Turborepo

`turbo.json` declares `build / typecheck / lint / test` pipelines with topological deps. Local + CI both run the same graph; remote cache wired but disabled until vendor pick.

### ADR-008 — OpenAPI as single source of truth (planned)

`@asteasolutions/zod-to-openapi` will emit OpenAPI 3.1 directly from Zod schemas; `openapi-typescript` consumes that into `packages/shared-types/src/api.ts`. CI will fail PRs whose API change doesn't update the generated client. **Not yet implemented** — see ROADMAP.md.

### ADR-009 — Read-only observability plane (no origination)

Public mutation surface: auth, partner onboarding, user admin. That's it. All financial state changes arrive via webhooks. PII can be viewed by operators with audit logging — never used to drive any action from this system.

### ADR-010 — Cookie session + WS ticket auth

- Access JWT (15 min) and refresh token (rotated, 7 day) live in `httpOnly; Secure; SameSite=Strict` cookies.
- CSRF: double-submit token in `epi_csrf` cookie + `X-CSRF-Token` header, signed by the JWT secret.
- WS: `POST /auth/ws/ticket` (cookie-authed, CSRF-checked) → 30-second single-use ticket → `WS /ws/analytics?ticket=…`. Ticket consumed on connect via Redis `GETDEL`.

### ADR-011 — Append-only RevenueEvent ledger

Every dollar shown on a dashboard projects from `revenue_events`. Inserted by the webhook worker, never updated, never deleted (REVOKE at role level). Clawbacks/reversals are _new_ negative-amount rows. Investor revenue numbers reconcile to a journal — every line auditable to the originating webhook.

### ADR-012 — Single typeface, navy + light-blue palette

Inter throughout, including for numbers (tabular figures via `tnum` font feature). No JetBrains Mono, no monospace anywhere. Palette: navy ink, paper background, accent blue, light blue. Status pills use blue + slate variations — no traffic-light green/amber/red. Decision driven by founder review feedback; reduces visual noise and signals neutral data presentation.

---

## Data flow per source

**BuzzPay → us:**

```
BuzzPay event → POST /webhooks/buzzpay/* (HMAC + Idempotency-Key)
  → middleware.verifySignature → middleware.idempotencyGuard → repo.WebhookEvent.create(RECEIVED)
  → queue.webhook.add(jobPayload)        ← reply 202
  → worker.consume → service.process       (in tx)
    ├─ application: create/update Application row (PII encrypt at boundary)
    ├─ lender-decision: create/update LenderDecision row
    ├─ funding-status: update LenderDecision.funding* + insert RevenueEvent (FUNDING)
    ├─ clawback: insert RevenueEvent (CLAWBACK, negative amount)
  → repo.WebhookEvent.update(PROCESSED)
  → emit WS event via Redis pub/sub channel `ws:analytics`
```

**Pixie/HighSale → us (daily batch):**

```
Pixie nightly job → POST /webhooks/pixie/usage [{partnerId, date, pulls}]
  → same HMAC + idempotency flow
  → worker computes margin via sliding scale (env: PIXIE_VOLUME_BREAKPOINT/COST/CHARGE)
  → PixieMetric upsert + RevenueEvent (PIXIE_MARGIN) per partner per day
  → WS event pixie.usage_reported
```

**MiCamp → us:**

```
MiCamp processing reports → POST /webhooks/micamp/processing
  → worker → RevenueEvent (PROCESSING_FEE) at 50% of reported gross fee
MiCamp reversal → POST /webhooks/micamp/reversal
  → worker → RevenueEvent (REVERSAL, negative amount)
```

---

## Performance targets

| Endpoint                      | Target p99 | Strategy                                               |
| ----------------------------- | ---------- | ------------------------------------------------------ |
| `GET /analytics/overview`     | <100 ms    | Redis 30s cache + parallel Prisma + Timescale CAGG     |
| `GET /analytics/revenue` (1y) | <150 ms    | Continuous aggregate, no row-by-row                    |
| `POST /webhooks/*`            | <30 ms     | verify + persist + enqueue                             |
| `GET /partners` (page)        | <80 ms     | composite index `(deletedAt, createdAt DESC, id DESC)` |
| WS event fanout               | <50 ms     | Redis pub/sub, no DB round-trip                        |

---

## Architectural invariants

Enforced via code review on every PR:

1. **No Prisma calls outside `*.repository.ts`.** Services accept repo interfaces via constructor.
2. **No `any`. No bare `as` casts** outside Zod boundaries.
3. **Every route handler:** Zod-parse → service call → response envelope. ≤30 lines.
4. **Every mutation:** wrapped in transaction + emits audit log row.
5. **PII fields** routed through `shared/utils/encryption.ts` AES-256-GCM helper. Plaintext never touches Prisma.
6. **Webhook handlers** are write-only to the queue. Processing happens in workers — keeps p99 ingest latency flat under burst.
7. **Money never crosses a JS `number`.** Decimal → string at the wire.
8. **Time never crosses a "timezone-unaware string".** UTC ISO end-to-end.

---

## Deployment topology (v1)

Single Linux host, docker-compose:

- `postgres` (TimescaleDB image)
- `redis`
- `api` (Node 20, Fastify)
- `worker.webhook` (separate process, scaled horizontally)
- `worker.aggregation` (single replica, runs cron-driven rollups)
- `web` (Next.js, behind same TLS termination)

v1.1 target: managed (Fly / Railway / ECS), TBD pending CTO decision (see ROADMAP.md).

---

## Backups / DR

- Nightly `pg_dump` to S3 (lifecycle: 30d hot, 1y archive)
- 4-hourly `pg_basebackup` WAL archive (RPO ≤ 4h, RTO ≤ 30 min)
- Redis treated as ephemeral cache — no separate backup; queue durability handled by BullMQ rehydrating from Postgres on restart

---

## Observability hooks

- Pino structured JSON logs, request-correlated by `requestId`
- `/health` returns DB + Redis status with latency
- `/admin/health` (admin-only) returns queue depths, session counts, PII access counts, webhook health by source
- `/admin/webhook-events` for inbound stream inspection
- Architecturally ready for OpenTelemetry — placeholders in `index.ts`; vendor pick + wiring in ROADMAP.md
