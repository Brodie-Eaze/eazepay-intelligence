# Compute limits & scale envelope

How much load this platform can absorb at the current configuration, and how to scale each axis.

## Workload profile

The platform tracks data across thousands of data points daily in real time. The hot paths are:

- **Vendor webhook ingress** — BuzzPay, MiCamp, Pixie. Bursty (vendor retry storms can 5× normal volume in 60s).
- **Programmatic ingestion** — internal ETL workers + dev backfills via PAT.
- **Dashboard reads** — analytics, audit log, customer book. Read-heavy, latency-sensitive.
- **Background workers** — outbox sweeper, webhook fan-out, delivery retries, exports.

Each axis is sized independently so a spike in one doesn't starve the others.

---

## Rate limits (current defaults)

Configured via env (`apps/api/src/config/env.ts`). Buckets are Redis-backed; key is `auth.userId` for authenticated traffic, `req.ip` otherwise.

| Tier                       | Default            | Bucket key    | Rationale                                                                                                    |
| -------------------------- | ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------ |
| Anonymous                  | 100 / min          | `req.ip`      | Floor for `/auth/login`, `/health`, etc. Tight enough to deflate brute-force attempts.                       |
| Authenticated (default)    | 1,000 / min        | `auth.userId` | Per-user, not per-IP. A dev behind a corporate NAT shouldn't share a bucket with the rest of the office.     |
| Ingestion                  | 6,000 / min        | `auth.userId` | Targets 100 events/sec sustained per PAT. Bulk endpoints take 500 events/request, so this is 12 batches/min. |
| Webhook ingress            | 10,000 / min       | `req.ip`      | Vendor retry storms (BuzzPay's exponential backoff can replay 5× in 60s) shouldn't trip ingress.             |
| Login (per-IP + per-email) | 5/15min + 10/15min | composite     | Stricter than the global anonymous floor.                                                                    |

**Failure mode**: Redis outage → rate limit fails closed (`skipOnError: false`). This is the correct SOC 2 posture — better a brief 503 than unbounded volume during a Redis outage.

**Scaling**: bump the env vars. Buckets are per-process? No — they're Redis, so they're cluster-wide. One change rolls to all replicas instantly.

---

## Body limits

Per-route, configured via env. Routes that don't override get `BODY_LIMIT_DEFAULT_BYTES`.

| Surface         | Default | Override env               | Reason                                                                                                        |
| --------------- | ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| UI / default    | 1 MiB   | `BODY_LIMIT_DEFAULT_BYTES` | Most dashboard requests are tiny.                                                                             |
| Bulk ingestion  | 8 MiB   | `BODY_LIMIT_BULK_BYTES`    | 500 events × ~16 KiB each. Caps memory pressure during backfill.                                              |
| Webhook ingress | 2 MiB   | `BODY_LIMIT_WEBHOOK_BYTES` | BuzzPay's largest known payload (`lender-decision` with full enrichment) is ≤ 1 MiB; 2 MiB gives 2× headroom. |

---

## Database

### Writer / reader split

Two singletons: `getPrismaWriter()` (primary) and `getPrismaReader()` (replica). Reads opt into the replica explicitly; writes always go to primary.

- **Replica configured (`DATABASE_REPLICA_URL` set)**: analytics + dashboard reads route there. Replication lag tolerated up to ~30s for those views.
- **Replica missing or down**: reader silently falls back to writer. Health probe surfaces `replica: degraded` so ops sees it.

**Routes pinned to the reader** (heavy aggregation, lag-tolerant):

| Domain    | Route prefix                            | Why                                        |
| --------- | --------------------------------------- | ------------------------------------------ |
| Analytics | `/analytics/*`                          | Dashboard rollups, materialized views      |
| Customers | `/customers`, `/customers/:hash*`       | Book reads + stats aggregations            |
| Admin     | `/audit-logs`, `/admin/webhook-events*` | Log browsing, large historical reads       |
| Lenders   | `/lenders*`, `/lenders/waterfall`       | Decision aggregates                        |
| Revenue   | `/revenue/*`                            | Ledger views, by-stream/by-partner rollups |
| Search    | `/search` (GET only)                    | Cross-domain search                        |
| Portfolio | `/portfolio/*` (GET)                    | Currently fixture-backed; replica-ready    |

**Routes pinned to the writer** (mutations + read-after-write):

| Domain      | Route prefix                                | Why                                                    |
| ----------- | ------------------------------------------- | ------------------------------------------------------ |
| Auth        | `/auth/*`                                   | Login → set cookie + read user must be consistent      |
| Partners    | `/partners*` (POST/PATCH/DELETE)            | CRUD; create→read response must reflect write          |
| Saved views | `/saved-views/*` (POST/DELETE)              | Read-then-delete uses writer to avoid replica-lag race |
| API tokens  | `/api-tokens*` (POST/DELETE)                | Issue → list must show new token immediately           |
| Ingestion   | `/ingestion/*`, `/portfolio/*` (POST/PATCH) | Writes by definition                                   |
| Webhooks    | `/webhooks/*`                               | Inbound writes                                         |

**Replication lag visibility**: `/health/ready` runs `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms` against the replica and returns `replicaLagMs` in the body. >30s flags `replica: degraded`.

### Connection pool

Set via `DATABASE_URL` query string (`?connection_limit=N&pool_timeout=S`).

| Variable         | Default | Sizing                                                                 |
| ---------------- | ------- | ---------------------------------------------------------------------- |
| connection_limit | 10      | Per-process. Total connections ≈ N × (api replicas + worker replicas). |
| pool_timeout     | 20s     | Time a request waits for a free connection before erroring.            |

**Capacity math**: Postgres `max_connections` typically 100 on managed RDS small. With 4 api replicas + 4 workers + connection_limit=10, that's 80 connections — leaves 20 for migrations, ad-hoc psql, etc. At connection_limit=20 with 8 replicas, you've maxed out and need PgBouncer.

**At PgBouncer time**: deploy PgBouncer in transaction-pool mode and point `DATABASE_URL` at it. Prisma v5+ supports this transparently.

### Statement / transaction / lock timeouts (role-level)

Set in `apps/api/prisma/init-timescale.sql`:

```sql
ALTER ROLE eazepay_app SET statement_timeout = '30s';
ALTER ROLE eazepay_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE eazepay_app SET lock_timeout = '5s';
```

Application code cannot opt out — every connection inherits these.

**For long-running workers** (export pipeline, aggregation backfill): connect as a separate `eazepay_worker_long` role with relaxed timeouts. Documented as a v1.1 deployment task.

### Slow-query logging

Prisma `$on('query')` logs anything ≥ `DATABASE_SLOW_QUERY_LOG_MS` (default 500ms) at WARN. Pipe these to your log aggregation; alert on a sustained increase.

---

## Worker concurrency

Each worker is a separate process (`pnpm --filter api worker:webhook` etc). Concurrency env-driven:

| Worker            | Default | Env                           | Notes                                                                                          |
| ----------------- | ------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Webhook processor | 10      | `WORKER_WEBHOOK_CONCURRENCY`  | I/O-bound (DB writes + Redis); 10 is safe for a 1-vCPU pod.                                    |
| Delivery worker   | 20      | `WORKER_DELIVERY_CONCURRENCY` | Outbound HTTP, 15s per call timeout — high concurrency safe.                                   |
| Outbox sweeper    | (poll)  | `WORKER_OUTBOX_BATCH=100`     | 100 events × 1s poll = 6,000 events/min/replica. Linearly scalable via FOR UPDATE SKIP LOCKED. |

**Scaling**: more replicas of the same worker process. BullMQ + Redis fan-out is non-overlapping by construction.

---

## End-to-end capacity envelope

Concrete numbers at the **default config**, single-replica everything:

| Metric                                | Sustained | Burst (60s) | Bottleneck if exceeded               |
| ------------------------------------- | --------- | ----------- | ------------------------------------ |
| Vendor webhook events (per source IP) | 167/sec   | 10k/min     | Rate limit → 429                     |
| Ingestion events (per PAT)            | 100/sec   | 6k/min      | Rate limit → 429                     |
| Total webhook+ingestion (combined)    | ~250/sec  | ~15k/min    | Outbox sweep + DB writes             |
| Outbox sweep                          | 100/sec   | 6k/min      | Add a sweeper replica → linear scale |
| Webhook fan-out (per replica)         | 10/sec    | (unbounded) | Add delivery worker replica          |
| Dashboard read RPS (per user)         | 16.6/sec  | 1k/min      | Replica read pool                    |
| API server connection pool            | 10        | -           | Bump connection_limit + add replica  |

At **3× replicas** (api, webhook worker, delivery worker, outbox sweeper) with a configured read replica, the platform absorbs roughly:

- ~750 webhook events/sec sustained
- ~30k events/min burst
- ~250M events/year throughput before vertical bottleneck

That's >>> "thousands of data points daily" by ~3 orders of magnitude. The platform is designed for the 100k–1M events/day range; the hot paths only become a real concern at >5M events/day.

---

## Failure-mode matrix

| Failure                   | Effect                                                        | Mitigation                                                                              |
| ------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Replica down              | Reader falls back to writer — degraded perf, no errors        | `/health/ready` reports `replica: degraded`; ops alert.                                 |
| Primary down              | All writes 503; reads from replica still work                 | Deploy primary failover (managed by RDS / Aurora / Patroni at infra layer)              |
| Redis down                | Rate limits + idempotency cache fail closed → 503             | Redis cluster + sentinel; investigate root cause                                        |
| BullMQ queue backed up    | Outbox accumulates; sweeper sees oldest first (FIFO ordering) | Scale workers horizontally; sweep cadence stays ≤1s                                     |
| Slow query                | Prisma WARN logged; statement_timeout cancels at 30s          | Slow-query alert → query plan review                                                    |
| Connection pool exhausted | Requests queue up to pool_timeout → 5xx                       | Bump `connection_limit`; deploy PgBouncer when totals exceed Postgres `max_connections` |
| OOM during bulk ingestion | Pod restarted by orchestrator                                 | `BODY_LIMIT_BULK_BYTES` caps payload at 8 MiB; Zod validates row count ≤500             |

---

## What's NOT in scope here

These belong at the infrastructure layer, not application code. Document them in your deploy runbook:

- TLS termination + HSTS (load balancer)
- WAF + DDoS shield (Cloudflare / AWS WAF)
- Postgres replication topology (RDS Multi-AZ / Aurora / Patroni)
- Backup cadence + restore drills (RPO ≤ 5 min, RTO ≤ 1 hr targets)
- Cross-region replica failover
- PgBouncer deployment (when connection_limit math exceeds Postgres max_connections)
