# Eaze Intelligence · Engineering Reference + Data Flow

> Everything in the Eaze Intelligence platform — in one doc.

**Part A** walks the data flow end-to-end (vendor webhook → normalised row → operator dashboard). **Part B** is the surface-by-surface reference for every page, system, integration, and DB table. Every Reference card links to the Flow phase(s) it appears in.

| 12              | 60             | 9                   | 80+                     |
| --------------- | -------------- | ------------------- | ----------------------- |
| **FLOW PHASES** | **FLOW STEPS** | **REFERENCE PARTS** | **SURFACES DOCUMENTED** |

---

## What Eaze Intelligence is (and isn't)

Eaze Intelligence is the **data warehouse for every business in the EazePay group**. It is NOT a consumer-facing product. There are no buyers, no operators-bringing-clients, no checkout. Every user of this platform is an internal operator (admin / operator / viewer / investor scope) of one of the EazePay-group brands.

It exists because four independent vendors (EazePay App, HighSale, MiCamp, Pixie) each emit a stream of events about the same underlying applications + customers + loans, and a fifth set of vendors (lenders) post-back outcome data on their own schedule. Eaze Intelligence ingests every plane, normalises them into a coherent domain model under strict per-tenant isolation, and surfaces the unified picture to operators in real time.

The product surface area is large for one reason: it has to absorb every shape of data those upstream vendors emit, while presenting one consistent operator experience that doesn't leak the vendor diversity.

---

# PART A · Data Flow

Every phase of the data journey, in the order it actually happens. From a vendor's HTTP POST to an operator's dashboard pixel.

## 01 · Inbound — vendors deliver

How upstream data lands on the platform. Five inbound planes, each with its own HMAC contract.

### 1.1 — EAZEPAY APP · Application-lifecycle webhooks

EazePay App POSTs every state transition to `POST /api/v1/integration/eazepay-app/events`. Event types: `application.offers_presented`, `application.contracted`, `application.declined`, `application.funded`, `merchant.onboarded`, `merchant.status_changed`, `revenue.recorded`, `loan.repayment.*`. Body = canonical envelope `{id, eventId, eventType, subject, data, createdAt}`. Tenant resolution today is via `data.brand` body field (deferred to SEC-005 per-tenant credential migration).

**HTTP ENDPOINT** `POST /api/v1/integration/eazepay-app/events` · HMAC-SHA-256 signed

### 1.2 — HIGHSALE · Credit-data snapshots

HighSale (EZ Check) POSTs the full credit-data snapshot per applicant after the bureau pull completes. Body is ~70 fields. PII (name/email/phone) encrypted at rest via per-org DEK; non-PII columns are queryable directly.

**HTTP ENDPOINT** `POST /api/v1/integration/highsale/snapshots` · HMAC-SHA-256 signed

### 1.3 — MICAMP · Processing webhooks

Card processing fees + reversals. Two endpoints: `processing.completed` (fee earned) and `processing.reversed` (refund / chargeback). 50/50 revenue share with partner is materialised per event.

**HTTP ENDPOINTS** `POST /api/v1/webhooks/micamp/processing-completed` · `POST /api/v1/webhooks/micamp/processing-reversed`

### 1.4 — PIXIE · Usage metering

Pre-qualification pulls. Sub-second hot path, partner-level visibility. Fires on every Pixie API call from a partner integration.

**HTTP ENDPOINT** `POST /api/v1/webhooks/pixie/usage-reported`

### 1.5 — LENDERS · Polling adapters

Lenders don't push — we pull. Per-lender adapter polls each lender's reporting API on a 15-minute cron, normalises to our `lender_reporting_events` shape. Lender adapters live in `apps/api/src/domains/lenders/adapter/`.

**SYSTEM** `lender-polling.worker.ts` · 15-minute cron · per-lender adapter registry

### 1.6 — INGESTION · PAT-driven bulk + single

Authenticated equivalent of the signed-webhook path for devs + ETL workers. Bearer-token (PAT) auth, same downstream processing. Used for backfills + adhoc loads.

**HTTP ENDPOINTS** `POST /api/v1/ingestion/{source}/events` · Bearer PAT · 6000 req/min per source

---

## 02 · Verify — signature + replay + tenancy

What happens to every inbound webhook before a single byte is persisted.

### 2.1 — Raw-body capture

Server-level content-type parser retains `req.rawBody` (the exact bytes the vendor signed) alongside the parsed body. Without this, `JSON.stringify(parsed)` ≠ vendor's signed input and every signature would fail on non-canonical JSON. Lives in `apps/api/src/server.ts` content-type parser override.

**SYSTEM** Raw-body capture · `apps/api/src/server.ts:120-138`

### 2.2 — HMAC verification

Every receiver computes `HMAC-SHA-256(secret, ts + "." + rawBody)` and `timingSafeEqual` compares it against the vendor's `x-*-signature` header. Length-equality pre-check before `timingSafeEqual` so the comparison itself is constant-time. Receivers: `eazepay-app.routes.ts:60`, `highsale.routes.ts:50`, `webhook-signature.middleware.ts` (generic for MiCamp/Pixie).

**SYSTEM** HMAC verify · constant-time compare · clock-skew tolerance 5min

### 2.3 — Timestamp tolerance

`Math.abs(now - ts) > 300` rejects replay attempts older than 5 minutes. Pinned at the receiver, separate from the HMAC.

**SYSTEM** Clock-skew gate · TOLERANCE_SECONDS=300

### 2.4 — Idempotency-key shape gate

Every receiver enforces `/^[A-Za-z0-9_-]{16,128}$/` on the `idempotency-key` header BEFORE any Redis or DB touch. Without this, a signed sender could SETNX multi-MB keys and balloon Redis memory.

**SYSTEM** `IDEMPOTENCY_KEY_RE` · pre-Redis gate

### 2.5 — Two-layer dedup · Redis SETNX → DB unique

Layer 1: Redis `SET key NX EX 86400` is the hot path. Layer 2: Postgres unique on `(org_id, source, idempotency_key)` is the source-of-truth backstop on Redis miss. The Redis layer is what serialises concurrent identical requests; the DB unique catches everything the Redis layer missed.

**SYSTEM** Dual idempotency · Redis SETNX + Postgres unique constraint

### 2.6 — WebhookEvent row written

Source-of-truth INSERT into `webhook_events`: id (uuidv7), orgId, source, eventType, idempotencyKey, signatureValid, payload (raw JSON). This row is what the drain worker consumes downstream. WebhookEvent payload is purged after 90 days (lifecycle.worker).

**DATA** `webhook_events` INSERT · orgId resolved at this point

---

## 03 · Quarantine — failed-event triage

When verification passes but downstream normalisation fails, the event lands in quarantine for operator triage instead of being silently dropped or replayed forever.

### 3.1 — Brand quarantine (EazePay App)

If `data.brand` doesn't map to any known org, the event lands in `eazepay_app_quarantine` with reason `brand_unknown`. Operator can either re-assign to a real org OR delete.

**DATA** `eazepay_app_quarantine` table · per-row reason

### 3.2 — Outbox DLQ

The cross-system outbox writer (`outbox.worker.ts`) sweeps `outbox_events` and dispatches to registered subscribers. Rows that exceed max retries land in `outbox_events.status = 'DLQ'`. Operators view + replay via `/platform/quarantine`.

**DATA** `outbox_events` DLQ status · operator-triaged

### 3.3 — Platform quarantine UI

`/platform/quarantine` lists both quarantine kinds with replay actions. Replay requires MFA step-up (`/auth/mfa/step-up`) — these are SUPER actions.

**PAGE** `/platform/quarantine` · MFA-gated replay

---

## 04 · Drain — workers normalise into the domain model

Workers consume WebhookEvent rows and write to the typed domain tables.

### 4.1 — webhook.worker.ts

The generic webhook drain. Pulls `webhook_events` rows that need processing, dispatches by `source + eventType` to the right handler. BullMQ-backed, 10 concurrent jobs default.

**WORKER** `webhook.worker.ts` · concurrency=10 · Redis-backed

### 4.2 — EazePay App processor

`apps/api/src/domains/integration/eazepay-app/eazepay-app.service.ts`. Wraps every drain inside `withTenantSession(prisma, {orgId}, ...)` so the runtime RLS context is set BEFORE any write. Handlers per event type:

- `application.offers_presented` → upsert Application + offers
- `application.contracted` → Application.status=CONTRACTED + funding event row
- `application.declined` → Application.status=DECLINED
- `application.funded` → Application.status=FUNDED + RevenueEvent ledger row
- `merchant.onboarded` → upsert Partner
- `merchant.status_changed` → Partner status update
- `revenue.recorded` → RevenueEvent ledger row
- `loan.repayment.*` → RevenueEvent (commission/repayment streams)

**SERVICE** `EazepayAppProcessor.process(job)` · 8 event-type handlers

### 4.3 — HighSale processor

Snapshot lands in `credit_enrichments` table. PII columns encrypted via `encryptForOrg(orgId, plaintext)` — the per-org DEK is resolved from `tenant_encryption_keys` and AES-GCM-wrapped under the AWS KMS root key (or local KMS in dev). Hash columns (`consumer_email_hash`, `consumer_phone_hash`) computed via HMAC-keyed SHA256 for indexable lookup without exposing plaintext.

**SERVICE** HighSale processor · per-org DEK envelope encryption

### 4.4 — MiCamp + Pixie processors

Smaller — these vendors only emit revenue / usage events. Each writes one `revenue_events` row (append-only ledger).

**DATA** `revenue_events` ledger · append-only · partitioned by month (TimescaleDB hypertable)

### 4.5 — Outbox writer

Every domain write that needs to fan out (lender notifications, partner webhooks, scheduled reports) appends to `outbox_events` in the SAME transaction as the domain write. Two-phase commit substitute — guarantees "if the domain row landed, the outbox row landed too."

**SYSTEM** Outbox pattern · transactional consistency

### 4.6 — Outbox sweeper

`outbox.worker.ts` polls `outbox_events WHERE status='PENDING'` every 1s, `FOR UPDATE SKIP LOCKED` for non-overlapping batches across replicas, dispatches to subscribers, marks SENT or retries. DLQ after max attempts.

**WORKER** `outbox.worker.ts` · 1s sweep · 100 events/batch · 6000 ev/min/replica

---

## 05 · Encrypt — PII envelope crypto

How consumer PII gets locked down at write time.

### 5.1 — Tenant DEK lookup

Every encryption call resolves the per-org DEK from `tenant_encryption_keys` (one active row per org). The DEK is wrapped under the platform KMS root key — only KMS can unwrap.

**SYSTEM** Per-org DEK · `tenant_encryption_keys` table

### 5.2 — KMS factory

`apps/api/src/shared/kms/kms-factory.ts`. Picks driver from `KMS_DRIVER` env (`aws` | `local`) or auto-selects `aws` for `NODE_ENV=production`. AWS path requires `AWS_KMS_KEY_ARN`. Local path derives KEK via HKDF-SHA-256 from `KMS_DEV_SECRET` — dev/test only, refuses to construct in production (SEC-108).

**SYSTEM** KMS factory · AWS in prod, local-HKDF in dev

### 5.3 — AES-256-GCM envelope

`encryptForOrg(orgId, plaintext)` produces a v2 envelope: `[0x02, alg, keyId, iv, ct, tag]`. The tag is enforced at exactly 16 bytes via `createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 })` (closed against the truncated-tag forgery vector — semgrep `gcm-no-tag-length` is now zero findings).

**SYSTEM** AES-256-GCM · 16-byte tag enforced · CWE-310 closed

### 5.4 — Hash for indexable lookup

For columns we need to query without decrypting (e.g. "find customer by email hash"), we store `hashPII(plaintext) = HMAC-SHA256(PII_HASH_SECRET, normalised)`. The pepper makes rainbow-table attacks against a leaked DB infeasible.

**SYSTEM** `hashPII` · HMAC-keyed · indexable

### 5.5 — Decryption hot path

`decryptEnvelopeAuto(prisma, envelope, decryptFn)` dispatches by envelope version byte. v1 (legacy global key) → `decryptPII`. v2 (per-org DEK) → `decryptEnvelopeV2`. Both share the read path so callers don't case-switch.

**SYSTEM** `decryptEnvelopeAuto` · version-byte dispatch

---

## 06 · RLS — every query is org-scoped at the DB layer

Defence-in-depth multi-tenancy. Application-layer `where: { orgId }` is the first line; RLS is the database backstop.

### 6.1 — eazepay_app runtime role

The API connects as `eazepay_app NOBYPASSRLS` role (separate from the owner role used by `prisma migrate deploy`). Without BYPASSRLS, every query is subject to the RLS policies below. Provisioned via migration `20260517100000_phase1_6_eazepay_app_role` + ops sets the password out-of-band.

**ROLE** `eazepay_app` · NOBYPASSRLS · REVOKE UPDATE/DELETE on audit_logs (append-only)

### 6.2 — withTenantSession

`SET LOCAL app.org_id = '<uuid>'` runs at the start of every tenant-scoped Prisma transaction. RLS policies compare `org_id::text = current_setting('app.org_id', TRUE)` and return zero rows otherwise. The GUC is unset between requests.

**SYSTEM** `withTenantSession` wrapper · per-transaction GUC

### 6.3 — Policies on every tenant table

~25 tables under FOR ALL policies. Pattern: `USING (org_id::text = current_setting('app.org_id', TRUE) OR current_setting('app.platform_staff', TRUE) = 'true')`. Platform staff bypass for cross-tenant operator workflows; bypass is audited.

**DATA** RLS policies · ~25 tables · platform-staff bypass audited

### 6.4 — Startup self-check

`assertRuntimeDbRoleNotBypassRls()` runs at boot in production and refuses to start if `current_setting('is_superuser') = on` OR the connected role has `rolbypassrls = true`. Stops a silent regression where ops forgets to switch DATABASE_URL to the runtime role.

**SYSTEM** RLS guard at boot · refuses production start on misconfig

---

## 07 · Real-time — three places at once

Same pattern as the EazePay platform: one event publish, multiple subscribers (operator dashboards, audit firehose, outbound webhooks).

### 7.1 — publishWsEvent envelope

Every event published to the internal Redis pub/sub goes through `publishWsEvent(orgId, event)` which wraps as `{orgId, event}` on the wire. The envelope is what the WS gateway uses to filter per-tenant on send.

**SYSTEM** `ws-publisher.ts` · tenant-aware envelope

### 7.2 — WS ticket issuance

`POST /api/v1/auth/ws/ticket` (auth-cookie + CSRF gated) mints a 30-second single-use JWT with `kind=ws_ticket`. Embeds `userId, scope, orgId`. The token is also stored in Redis with TTL=30s — `consumeWsTicket` does `GETDEL` so it's truly single-use.

**SYSTEM** WS ticket · 30s TTL · GETDEL single-use

### 7.3 — WS gateway

`/api/v1/ws/analytics?ticket=...` accepts the ticket, parses orgId from the consume result, attaches it to the per-connection `ClientCtx`. The Redis subscriber loops `for (const c of clients) { if (!shouldDeliverToClient(c, envelope)) continue; c.send(...) }` — platform-staff (orgId=null) see everything, tenant-scoped clients see only their orgId's events.

**SYSTEM** `analytics.gateway.ts` · per-tenant filtered fan-out

### 7.4 — Outbound webhook fan-out

`OutboundWebhookService.dispatch(orgId, eventType, payload)` queries `outbound_webhook_subscriptions WHERE org_id = ? AND event_types @> ARRAY[?]` and enqueues a `webhook-delivery` BullMQ job per subscriber. The worker signs each delivery with the subscriber's secret (stored hashed) and POSTs to their URL with exponential backoff.

**WORKER** `webhook-delivery.worker.ts` · BullMQ · exp-backoff retry · DLQ on final fail

### 7.5 — Audit firehose

Every state change writes one `audit_logs` row via `writeAuditLog`. Action enum: USER_LOGIN, PII_ACCESSED, WEBHOOK_RECEIVED, EXPORT_REQUESTED, RTBF_PROCESSED, etc. PII-free metadata by contract (only hashes + IDs).

**DATA** `audit_logs` append-only · 70+ action types

---

## 08 · Surfacing — operator reads the data

How the normalised data reaches the operator dashboard.

### 8.1 — Next.js 14 web app

`apps/web` is a Next.js 14 app-router SPA. ~70 pages organised by domain. TanStack Query for server-state, Tailwind for styling, dark-mode default. Authenticates via `__Host-epi_access` cookie (set on `/auth/login` success). Every page mounts → calls `/api/v1/auth/me` → either redirects to `/login` or proceeds.

**APP** `apps/web` · Next.js 14 · 70+ pages

### 8.2 — Reader / writer split

`getPrismaReader()` routes to `DATABASE_REPLICA_URL` when set (5s lag-tolerant analytics + dashboard reads). Falls back to writer on replica failure. `getPrismaWriter()` for mutations + read-after-write. Reader has a runtime guard that refuses write actions.

**SYSTEM** Postgres writer/reader split · graceful fallback

### 8.3 — Live WebSocket

Dashboard pages that need live data (`/overview`, `/live`, `/applications/by-status`, `/platform/quarantine`) open one WS connection at mount and consume `WsEvent` discriminated union: `application.created`, `lender.decision`, `funding.completed`, `revenue.event`, `pixie.usage_reported`, `partner.tier_changed`, `system.heartbeat`.

**SYSTEM** `/ws/analytics` · single-page-per-tenant-pod connection · 15s heartbeat

### 8.4 — Investor scope

A user can toggle to `scope='investor'` (read-only, partner labels anonymised). The toggle re-issues an access token under a new family (independent revocation) and the WS gateway swaps in `scopeForInvestor(event)` before sending. Investor accounts can NEVER drop back to standard scope.

**SYSTEM** Scope toggle · `scopeForInvestor()` anonymisation

---

## 09 · Operator actions — write-side flows

What an operator can DO (vs. read).

### 9.1 — PII reveal · /customers/:hash/pii

Decrypts consumer name/email/phone for a customer hash. Gated on `auth.orgRole` (ADMIN or OPERATOR in the active org) AND scoped to `orgId` so the same hash in a sibling org is NOT revealed. Writes a `PII_ACCESSED` audit log with field list.

**ENDPOINT** `GET /api/v1/customers/:hash/pii` · MFA-step-up may be required · audit-logged

### 9.2 — Export job

Operator requests `POST /api/v1/exports` with format (CSV / JSONL) + filter. Enqueues an `export-pipeline` BullMQ job. Worker (`export.worker.ts`) runs as `eazepay_worker_long` role (5-min statement_timeout), streams rows in batches of 5000, writes to local disk OR S3 per `EXPORT_STORAGE_DRIVER`. Operator gets a notification when ready; presigned URL TTL configurable via `EXPORT_PRESIGN_TTL_SEC`.

**WORKER** `export.worker.ts` · long-running role · S3 storage · presigned URLs

### 9.3 — Scheduled report

Operator configures a daily/weekly cron in `/reports`. `scheduled-report.worker.ts` runs `0 * * * *` (every hour) and dispatches reports whose `next_run_at <= now()`. Sends to configured notification channels.

**WORKER** `scheduled-report.worker.ts` · hourly cron

### 9.4 — RTBF (Right To Be Forgotten)

Operator submits an email hash via `/admin/rtbf` (MFA-gated). `rtbf.service.ts` enqueues processing. `lifecycle.worker.ts` finds every Application carrying that `consumerEmailHash` and overwrites encrypted PII columns with zero buffers in one transaction. AES-GCM tag inside each envelope is part of the ciphertext bytes — zeroing the column makes the data cryptographically unrecoverable. Application row + downstream FK relationships preserved for the 7-year regulatory retention. RTBF request stamped COMPLETED with `applicationsScrubbed` count and audit row.

**SERVICE** `rtbf.service.ts` · cryptoshred · 7y retention of non-PII trail

### 9.5 — Outbox replay / DLQ replay

DLQ rows can be re-queued from `/platform/quarantine`. MFA step-up required. Resets the row's `attempt_count` and the next sweep picks it up.

**ENDPOINT** `POST /platform/outbox/dlq/:id/replay` · MFA-gated

---

## 10 · Lifecycle — retention + scrub + cleanup

Background workers that keep the platform tidy.

### 10.1 — Webhook payload TTL

`lifecycle.worker.ts` clears raw `webhook_events.payload` JSON after 90 days. Keeps the row (audit + idempotency lookup) but drops the bulky payload column.

**WORKER** `lifecycle.worker.ts` · 90-day payload scrub

### 10.2 — Refresh token expiry

Expired and revoked refresh tokens are purged. Reduces table bloat over the 7-day refresh TTL window.

**WORKER** `lifecycle.worker.ts` · refresh-token GC

### 10.3 — Aggregation rollups

`aggregation.worker.ts` rolls up `revenue_events` into `revenue_aggregations` (monthly per-partner totals). TimescaleDB continuous aggregate (`revenue_daily_cagg`) handles daily buckets. The aggregation worker handles monthly + arbitrary-period rollups not expressible as a CAGG.

**WORKER** `aggregation.worker.ts` · monthly rollups

### 10.4 — Lender polling

`lender-polling.worker.ts` polls every active lender adapter on a 15-minute cron. Each adapter normalises the vendor's reporting payload into `lender_reporting_events` rows.

**WORKER** `lender-polling.worker.ts` · per-lender cron

### 10.5 — Reconciliation

`/platform/reconciliation` shows `revenue_events` SUM vs. `revenue_aggregations` SUM per month. Drift > $0.005 means either the aggregation worker fell behind OR something bypassed the ledger. Either way, investigated.

**PAGE** `/platform/reconciliation` · books-tied-out check

---

## 11 · Workers + queues

Async backbone. BullMQ on Redis. 13 worker processes today.

### 11.1 — Worker process list

`webhook.worker` · `webhook-delivery.worker` · `outbox.worker` · `export.worker` · `aggregation.worker` · `lifecycle.worker` · `alert.worker` · `scheduled-report.worker` · `lender-polling.worker` · `pii-reencryption.worker` · `correlation-linker.worker` · `revenue.worker` · `retention.worker`

Each runs as its own process (Railway `intel` service deploys the worker fleet). Concurrency tuned per worker (1–10).

**SYSTEM** 13 BullMQ workers · Redis-backed · graceful shutdown with hard exit on close-rejection

### 11.2 — Queue health UI

`/ops/queues` shows job counts (waiting, active, completed, failed, delayed), retry rates, throughput per worker. Investigates worker stalls or DLQ buildup.

**PAGE** `/ops/queues` · queue-by-queue health

### 11.3 — Dead-letter queue

`outbox_events.status='DLQ'` rows are the queue-level DLQ. Operator-triaged via `/platform/quarantine`.

**DATA** Outbox DLQ · operator replay

### 11.4 — Graceful shutdown

Every worker has hardened SIGTERM/SIGINT handlers: `try { await worker.close(); process.exit(0); } catch { log.error; process.exit(1); }`. Closes the BullMQ queue cleanly so in-flight jobs aren't dropped, hard-exits on close-rejection (Redis-disconnect race) so the orchestrator restarts cleanly.

**SYSTEM** Worker shutdown handlers · 4 workers hardened post SF-A

---

## 12 · Tracking · observability · ops

Every action above leaves a trail.

### 12.1 — Audit log

Every actor action writes one `audit_logs` row (append-only by DB grant — `eazepay_app` role lacks UPDATE/DELETE). SOC 2 CC7.3 + FCRA evidence. ~70 action types: USER_LOGIN, PII_ACCESSED, WEBHOOK_RECEIVED, EXPORT_REQUESTED, RTBF_SUBMITTED, RTBF_PROCESSED, etc.

**PAGE** `/audit` · `/audit/logins` · `/audit/pii`

### 12.2 — Alert engine

`alert.worker.ts` evaluates rules from `alert_rules` on a cadence per rule (default 1 minute). Metrics: webhook failure rate, webhook event count, failed login count, application count, revenue amount, PII access count, ingestion rejected count, replication lag ms. Fires `alerts` row + notification channel dispatch on HIT.

**WORKER** `alert.worker.ts` · rule-driven · auto-resolve on COOL

### 12.3 — Metrics endpoint

`/metrics` exposes Prometheus-format counters/histograms (httpRequestsTotal, httpRequestDurationSeconds, outboxSweptTotal, outboxLagSeconds, etc.). Bearer-auth via `METRICS_BEARER_TOKEN` so it's not a public recon goldmine.

**ENDPOINT** `GET /metrics` · `METRICS_BEARER_TOKEN` gated

### 12.4 — Health

`/api/v1/health` returns Postgres replica lag + Redis ping + worker queue depth. Used by Railway healthcheck.

**ENDPOINT** `GET /api/v1/health`

### 12.5 — Activity firehose

`/live` page subscribes to the WS feed and shows every event flowing through the platform. Vibe-check / sales-room TV view.

**PAGE** `/live` · WS-subscribed firehose

### 12.6 — Webhook log

`/ops/webhooks` shows every raw inbound webhook across every signed-webhook source. `signature_valid` + `response_status` per row. Debugging surface when a partner asks "why isn't this event there?"

**PAGE** `/ops/webhooks` · inbound webhook log

---

# PART B · Platform Reference

Every surface, system, integration, and DB table explained on its own terms. Each card lists what it does, what it's for, and which Flow phase(s) it appears in.

## B1 · Inbound data planes · public-signed

Every public-facing webhook receiver. HMAC-signed. Stateless. Idempotent.

### 1.1 — EazePay App webhook receiver

**WHAT IT DOES:** Receives every application-lifecycle event from the EazePay App platform. 8 event types covering application state transitions + merchant lifecycle + revenue + loan repayments.
**WHAT IT'S FOR:** Single source of truth for application-level state in the warehouse.
**APPEARS IN FLOW:** Flow 01 · Inbound; Flow 02 · Verify; Flow 04 · Drain
**ENDPOINTS** `POST /api/v1/integration/eazepay-app/events`

### 1.2 — HighSale snapshot receiver

**WHAT IT DOES:** Receives the post-bureau-pull credit-data snapshot per applicant. ~70 fields per snapshot. PII encrypted at rest.
**WHAT IT'S FOR:** Credit-profile enrichment of every application — the data that powers risk-band, propensity-calibration, and income-distribution analytics.
**APPEARS IN FLOW:** Flow 01 · Inbound; Flow 04 · Drain; Flow 05 · Encrypt
**ENDPOINTS** `POST /api/v1/integration/highsale/snapshots`

### 1.3 — MiCamp processing receivers

**WHAT IT DOES:** Card processing fees + reversals. Drives 50/50 revenue share materialisation per partner.
**WHAT IT'S FOR:** Realised revenue tracking — the difference between "lender funded" and "money in the bank."
**APPEARS IN FLOW:** Flow 01 · Inbound; Flow 04 · Drain
**ENDPOINTS** `POST /api/v1/webhooks/micamp/processing-completed` · `POST /api/v1/webhooks/micamp/processing-reversed`

### 1.4 — Pixie usage receiver

**WHAT IT DOES:** Pre-qualification usage metering. Sub-second hot path.
**WHAT IT'S FOR:** Partner-level usage visibility + per-partner pre-qual cost attribution.
**APPEARS IN FLOW:** Flow 01 · Inbound; Flow 04 · Drain
**ENDPOINTS** `POST /api/v1/webhooks/pixie/usage-reported`

### 1.5 — Generic ingestion (PAT)

**WHAT IT DOES:** Authenticated equivalent of the signed-webhook path. Bearer-token (PAT) + idempotency-key + raw-body capture. Same downstream processing as webhooks.
**WHAT IT'S FOR:** Backfills, ETL workers, dev integration. Not for vendor traffic.
**APPEARS IN FLOW:** Flow 01 · Inbound
**ENDPOINTS** `POST /api/v1/ingestion/{source}/events` · `POST /api/v1/ingestion/{source}/bulk`

### 1.6 — Aurean AI / Aurean Recruitment receivers

**WHAT IT DOES:** Phase-H integrations for sibling-brand business events. Same signed-webhook pattern; per-source schema.
**WHAT IT'S FOR:** Cross-brand ops visibility once the Aurean platforms emit native webhooks.
**APPEARS IN FLOW:** Flow 01 · Inbound

---

## B2 · Auth & multi-tenancy

How a request goes from "someone hit our API" to "this is user X in org Y with role Z."

### 2.1 — Local password login

**WHAT IT DOES:** `POST /api/v1/auth/login` validates `(email, password, mfaCode?)`, issues an access JWT (15min) + refresh token (7d) + CSRF token, sets all three as `__Host-`-prefixed cookies.
**WHAT IT'S FOR:** Primary user-auth path for ops + admins.
**ENDPOINTS** `POST /api/v1/auth/login`

### 2.2 — Google OAuth

**WHAT IT DOES:** OAuth 2.0 + PKCE with Google. Sign-in only (never auto-creates users). Matches first on email (creates `sub` mapping), then on `sub` thereafter so a compromised email can't redirect a Google session to a different account. Domain allow-list defence-in-depth on top of Google's `hd` claim.
**WHAT IT'S FOR:** SSO for orgs that don't want password management.
**ENDPOINTS** `GET /api/v1/auth/oauth/google/start` · `GET /api/v1/auth/oauth/google/callback` · `GET /api/v1/auth/oauth/providers`

### 2.3 — MFA setup + verify

**WHAT IT DOES:** TOTP via otplib. `/auth/mfa/setup` generates a secret + QR code. `/auth/mfa/verify` accepts the first code and flips `users.mfa_enabled=true`. Subsequent logins require `mfaCode` in the body.
**ENDPOINTS** `POST /api/v1/auth/mfa/setup` · `POST /api/v1/auth/mfa/verify`

### 2.4 — MFA step-up

**WHAT IT DOES:** Issues a 5-minute single-use token (HMAC-signed) for SUPER actions. Atomically dedup'd via Redis `SET jti EX <ttl> NX` so the token can't be replayed across multi-pod deployments. Falls back to in-process Map only if Redis is unreachable.
**WHAT IT'S FOR:** Cryptoshred, RTBF, quarantine replay, impersonation-token issue — anything that needs proof of "the human at the keyboard authorised THIS request right now."
**ENDPOINTS** `POST /api/v1/auth/mfa/step-up/start` · `POST /api/v1/auth/mfa/step-up/verify`

### 2.5 — Personal Access Tokens

**WHAT IT DOES:** Mint a `epi_pk_<prefix>_<secret>` bearer token. Storage = HMAC-pepper'd hash (with optional `API_TOKEN_HASH_SECRET` migration). Per-token scopes (READ / WRITE / SUPER).
**WHAT IT'S FOR:** Programmatic access — ingestion workers, integration partners.
**ENDPOINTS** `POST /api/v1/api-tokens` · `GET /api/v1/api-tokens` · `DELETE /api/v1/api-tokens/:id`

### 2.6 — Session management

**WHAT IT DOES:** Per-session refresh-token family. Rotation on every refresh; reuse → revoke family. Deny-list (`denyJti`, `denySession`) for immediate revocation. `/auth/sessions` lists active sessions per user.
**WHAT IT'S FOR:** Logout-from-all-devices + session inventory.
**ENDPOINTS** `GET /api/v1/auth/sessions` · `DELETE /api/v1/auth/sessions/:id`

### 2.7 — RBAC + RLS multi-tenancy

**WHAT IT DOES:** Three layers: (1) `requireAuth` → JWT + DB user check + Membership re-check; (2) `resolveTenantFromPath` for `/o/:orgSlug/*` routes — loads org + Membership, populates `req.auth.orgId/orgRole`; (3) Postgres RLS policies enforce the same boundary at the DB.
**WHAT IT'S FOR:** Defence-in-depth multi-tenancy. App layer + DB layer must BOTH agree before a query returns a row.
**APPEARS IN FLOW:** Flow 06 · RLS

### 2.8 — Cookies

**WHAT IT DOES:** Three cookies set per session: `__Host-epi_access` (15min, httpOnly), `__Host-epi_refresh` (7d, httpOnly), `__Host-epi_csrf` (15min, JS-readable for double-submit). `__Host-` prefix blocks sibling-subdomain overshadow attacks on `*.up.railway.app`.
**WHAT IT'S FOR:** Browser-side auth state. CSRF token is the double-submit gate on every state-changing route.

---

## B3 · Operator web app · /

Every page in `apps/web`. Single SPA, dark-mode default, TanStack Query for server-state.

### 3.1 — `/overview`

**WHAT IT DOES:** Holdco dashboard. KPI cards (apps last 24h, revenue MTD, lender approval rate, WS connection health). Real-time event ticker.
**WHAT IT'S FOR:** First stop on login. The "is everything OK" snapshot.

### 3.2 — `/data-sources` (+ per-source detail pages)

**WHAT IT DOES:** Hub page showing every inbound plane with last-24h event count, last-received timestamp, HEALTHY/STALE/IDLE pill. Drill-in pages for `eazepay-app`, `highsale`, `pixie`, `micamp`, `lenders`, `partners`.
**WHAT IT'S FOR:** Where your data comes from — answers "is HighSale sending us anything?" at a glance.
**APPEARS IN FLOW:** Flow 01 · Inbound; Flow 04 · Drain

### 3.3 — `/applications` + `/applications/by-status`

**WHAT IT DOES:** Application book + status-column kanban view. Tenant-scoped (post-SEC-002 fix). Each row links to the consumer's customer page.
**WHAT IT'S FOR:** Application pipeline visibility per tenant.

### 3.4 — `/customers` family

**WHAT IT DOES:** Customer book (by email hash), detail page (full application history + credit timeline + total funded), PII reveal (`/customers/:hash/pii` — MFA + role-gated), credit-enrichment timeline, lender-data timeline. All routes tenant-scoped at both Prisma + raw-SQL layers.
**WHAT IT'S FOR:** Per-consumer ops + PII reveal under compliance trail.
**APPEARS IN FLOW:** Flow 08 · Surfacing; Flow 09 · Operator actions

### 3.5 — `/revenue` family

**WHAT IT DOES:** Revenue event ledger (`/revenue/ledger`), per-stream breakdowns (`/revenue/streams`), reconciliation page (`/revenue/reconciliation`) — ledger SUM vs. rollup SUM per month, drift > $0.005 flagged.
**WHAT IT'S FOR:** Money tracking + books-tie-out.
**APPEARS IN FLOW:** Flow 10 · Lifecycle

### 3.6 — `/analytics` (risk / income / propensity)

**WHAT IT DOES:** Aggregate analytics:

- `/analytics/risk-distribution` — credit-band buckets, avg income + propensity per bucket
- `/analytics/income-distribution` — income buckets, avg credit + funded amount
- `/analytics/propensity-calibration` — how well HighSale's propensity predicts approval / funding
  All tenant-scoped (post-SEC-002).
  **WHAT IT'S FOR:** Portfolio analytics for risk + sales teams.

### 3.7 — `/partners`

**WHAT IT DOES:** Partner directory + per-partner page (apps, revenue, lender mix, pixie usage). Brand-anonymised in investor scope.
**WHAT IT'S FOR:** Partner ops + commercial terms.

### 3.8 — `/lenders` family

**WHAT IT DOES:** Lender panel (`/lenders`), per-adapter health (`/lenders/adapters`), submit reporting events (`/lenders/submit`).
**WHAT IT'S FOR:** Lender ops + reporting-API debug.
**APPEARS IN FLOW:** Flow 01 · Inbound (1.5 polling); Flow 10 · Lifecycle

### 3.9 — `/highsale` + `/highsale/schema`

**WHAT IT DOES:** HighSale snapshot detail viewer + schema explorer for the ~70 fields HighSale emits.
**WHAT IT'S FOR:** Per-applicant credit-profile drilldown.

### 3.10 — `/pixie` + `/pixie/pricing`

**WHAT IT DOES:** Pixie usage events + pricing config.
**WHAT IT'S FOR:** Pre-qual usage metering visibility.

### 3.11 — `/micamp`

**WHAT IT DOES:** MiCamp processing events + per-partner rev-share materialisation.
**WHAT IT'S FOR:** Realised-revenue tracking.

### 3.12 — `/platform/*` (operator admin)

**WHAT IT DOES:** `/platform/quarantine` (failed-event triage), `/platform/orgs` (multi-tenant admin), `/platform/reconciliation` (books tie-out).
**WHAT IT'S FOR:** SUPER ops surfaces. All actions MFA-step-up gated.
**APPEARS IN FLOW:** Flow 03 · Quarantine

### 3.13 — `/audit` family

**WHAT IT DOES:** `/audit` (every action), `/audit/logins` (auth events), `/audit/pii` (PII-access trail).
**WHAT IT'S FOR:** SOC 2 / FCRA compliance evidence + "who did what when."
**APPEARS IN FLOW:** Flow 12 · Tracking

### 3.14 — `/ops/*`

**WHAT IT DOES:** `/ops/health` (system health), `/ops/queues` (BullMQ status), `/ops/sessions` (session inventory), `/ops/webhooks` (inbound webhook log).
**WHAT IT'S FOR:** On-call engineer's pager-page.
**APPEARS IN FLOW:** Flow 11 · Workers + queues; Flow 12 · Tracking

### 3.15 — `/exports`

**WHAT IT DOES:** Request + download exports. List of all exports, status (PENDING / RUNNING / READY / EXPIRED), presigned download URL.
**WHAT IT'S FOR:** Operator data-out flow.
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.2)

### 3.16 — `/reports`

**WHAT IT DOES:** Configure scheduled reports. Cron expression + notification channel + filter + format.
**WHAT IT'S FOR:** Recurring data-out (daily/weekly KPIs to ops Slack, finance email, etc.).
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.3)

### 3.17 — `/alerts`

**WHAT IT DOES:** Alert rules CRUD. Define metric, threshold, comparison, evaluation cadence, notification channel.
**WHAT IT'S FOR:** Self-service ops monitoring.
**APPEARS IN FLOW:** Flow 12 · Tracking (12.2)

### 3.18 — `/settings/*`

**WHAT IT DOES:** Per-user settings: MFA setup, sessions, API tokens, OAuth links, default org, notification prefs.
**WHAT IT'S FOR:** Self-service account management.

### 3.19 — `/kpis/*`

**WHAT IT DOES:** Per-brand KPI rollups for sibling Aurean platforms.
**WHAT IT'S FOR:** Cross-brand visibility (Phase H integration with Aurean AI / Aurean Recruitment).

### 3.20 — `/funnel`, `/income`, `/propensity`, `/risk`

**WHAT IT DOES:** Domain-specific analytics dashboards over the normalised data.
**WHAT IT'S FOR:** Specialist analytics for risk / commercial teams.

### 3.21 — `/live`

**WHAT IT DOES:** WS-subscribed activity firehose. Every event scrolling past.
**WHAT IT'S FOR:** Sales-room TV; engineer debug feed.
**APPEARS IN FLOW:** Flow 07 · Real-time

### 3.22 — `/search`

**WHAT IT DOES:** Cross-domain text search. Applications, customers, partners, audit log.
**WHAT IT'S FOR:** Quick lookup when you have a hash, an email, an application id.

### 3.23 — `/portfolio`

**WHAT IT DOES:** Portfolio-level rollups across brands.
**WHAT IT'S FOR:** Investor / holdco view.

---

## B4 · Domain APIs · /api/v1/\*

Every Fastify route module under `apps/api/src/domains`. 26 route files.

### 4.1 — `auth.routes.ts` + `oauth.routes.ts`

**WHAT IT DOES:** Local login, MFA setup, MFA step-up, session list, refresh, logout, OAuth start/callback. Composite rate-limited (per-user + per-IP).
**APPEARS IN FLOW:** Flow 08 · Surfacing (entry point)

### 4.2 — `applications.routes.ts`

**WHAT IT DOES:** Application list (paginated, filterable by status), detail, lender-decision sub-resource.
**APPEARS IN FLOW:** Flow 08 · Surfacing

### 4.3 — `customers.routes.ts`

**WHAT IT DOES:** Customer book + detail + PII reveal + credit-enrichment + lender-data. Tenant-scoped at every query (post-SEC-002).

### 4.4 — `revenue.routes.ts`

**WHAT IT DOES:** Revenue events list, per-stream rollups, reconciliation queries.

### 4.5 — `partners.routes.ts`

**WHAT IT DOES:** Partner CRUD + per-partner analytics.

### 4.6 — `lenders.routes.ts`

**WHAT IT DOES:** Lender panel + adapter health + submit reporting events + funding/decision routes.

### 4.7 — `pixie.routes.ts`, `micamp.routes.ts` (via webhooks)

**WHAT IT DOES:** Vendor-specific routes for adapter-driven flows.

### 4.8 — `webhooks.routes.ts`

**WHAT IT DOES:** Vendor-webhook receivers for MiCamp + Pixie. (EazePay App + HighSale have their own route modules under `integration/`.)
**APPEARS IN FLOW:** Flow 01 · Inbound; Flow 02 · Verify

### 4.9 — `ingestion.routes.ts`

**WHAT IT DOES:** PAT-driven generic ingestion. Single-event + bulk endpoints per source.

### 4.10 — `outbound-webhooks.routes.ts`

**WHAT IT DOES:** Outbound subscriptions CRUD + delivery log.
**APPEARS IN FLOW:** Flow 07 · Real-time (7.4)

### 4.11 — `exports.routes.ts`

**WHAT IT DOES:** Export request + status + download. Format = CSV / JSONL. Worker handles the actual streaming.
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.2)

### 4.12 — `scheduled-reports.routes.ts`

**WHAT IT DOES:** Scheduled report CRUD + manual run.
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.3)

### 4.13 — `alerts.routes.ts`

**WHAT IT DOES:** Alert rule CRUD + alert event list + acknowledge / resolve.
**APPEARS IN FLOW:** Flow 12 · Tracking (12.2)

### 4.14 — `rtbf.routes.ts`

**WHAT IT DOES:** Submit RTBF request, list pending/processing/completed, manual replay if stuck. MFA step-up gated.
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.4)

### 4.15 — `admin.routes.ts` + `platform.routes.ts`

**WHAT IT DOES:** Platform-staff cross-tenant admin routes. Tenant offboarding, org provisioning, secret rotation triggers, replication-lag queries, KMS rotation.

### 4.16 — `users.routes.ts` + invitations

**WHAT IT DOES:** User CRUD per org + invitation flow (one-time-use tokens, RLS-bypass via `app.invitation_lookup` GUC for unauthenticated reads).

### 4.17 — `analytics.routes.ts`

**WHAT IT DOES:** Aggregate analytics queries powering the dashboard pages (risk / income / propensity / funnel).

### 4.18 — `health.routes.ts`

**WHAT IT DOES:** `/api/v1/health` — Postgres ping, Redis ping, replica lag.

### 4.19 — `notes.routes.ts` + `tags.routes.ts` + `search.routes.ts`

**WHAT IT DOES:** Cross-domain annotation + tagging + search.

### 4.20 — `portfolio.routes.ts`

**WHAT IT DOES:** Cross-brand portfolio rollups.

### 4.21 — `integration/eazepay-app/*` + `integration/highsale/*` + Aurean

**WHAT IT DOES:** Dedicated route modules for the big-vendor integrations. Each has its own signature-verify + drain logic.

### 4.22 — `fx.routes.ts`

**WHAT IT DOES:** FX rate lookup for multi-currency revenue normalisation.

---

## B5 · Backend systems · no UI

The headless services + middleware.

### 5.1 — Fastify server bootstrap

**WHAT IT DOES:** Single `buildServer()` factory. Plugin order LOCKED: helmet → cors → sensible → rate-limit → websocket → auth → routes. Per-request UUIDv7 IDs (validated to prevent log injection). 60s plugin timeout (raised 2026-05-24 to absorb cold-start Redis stutters). Decimal reply serializer preserves Prisma `Decimal` precision (Decimal → string).
**WHAT IT'S FOR:** Single entry point for both production server + integration tests.

### 5.2 — KMS factory

**WHAT IT DOES:** Picks AWS KMS or local KMS by env. Driver bootstrap fail-fast on missing config in production (`AWS_KMS_KEY_ARN` required) — softened to warn under `RLS_GUARD_MODE` and the 2026-05-24 env-safety relaxation.
**APPEARS IN FLOW:** Flow 05 · Encrypt (5.2)

### 5.3 — Per-org DEK envelope

**WHAT IT DOES:** AES-256-GCM with 16-byte tag (enforced). Version-byte dispatch on decrypt (v1 legacy / v2 per-org / v3 AAD planned per ADR-006).
**APPEARS IN FLOW:** Flow 05 · Encrypt

### 5.4 — Outbox dispatcher

**WHAT IT DOES:** Transactional outbox writer + sweeper. Guarantees "domain row landed → outbox row landed too" via single DB transaction. Sweeper uses `FOR UPDATE SKIP LOCKED` for non-overlapping multi-replica batching.
**APPEARS IN FLOW:** Flow 04 · Drain (4.5, 4.6)

### 5.5 — Pino logger

**WHAT IT DOES:** Structured JSON logging with PII redaction. ~200 redact paths covering every consumer-PII field name, crypto envelope material, env-shaped secrets, vendor signature headers, raw bodies. Contract regression test (`logger-pii-redaction.test.ts`) covers 70 cases — adding a new PII column without extending the redact list fails CI.
**APPEARS IN FLOW:** Flow 12 · Tracking

### 5.6 — Audit log middleware

**WHAT IT DOES:** `writeAuditLog({req, userId, action, resourceType, resourceId, metadata})` — single helper, ~70 action enum values. Append-only by DB grant (eazepay_app role lacks UPDATE/DELETE on audit_logs).
**APPEARS IN FLOW:** Flow 07 · Real-time (7.5); Flow 12 · Tracking (12.1)

### 5.7 — Composite rate-limit middleware

**WHAT IT DOES:** Per-route rate-limit factory. Builds keys from multiple sources (user + IP + custom), atomically increments via Redis MULTI pipeline, throws 429 on bucket exceeded. Fails OPEN on Redis error (post 2026-05-24 incident — was fail-CLOSED → 503 on every login during Redis flap).
**APPEARS IN FLOW:** Flow 02 · Verify; Flow 08 · Surfacing

### 5.8 — Webhook-signature middleware

**WHAT IT DOES:** Generic HMAC-verify pipeline for MiCamp + Pixie. Vendor-specific receivers (EazePay App, HighSale) have their own inline verify because of payload-shape differences.
**APPEARS IN FLOW:** Flow 02 · Verify

### 5.9 — Bearer-auth middleware

**WHAT IT DOES:** PAT verification. Parses `Bearer epi_pk_<prefix>_<secret>`, looks up by prefix, constant-time compare hashed secret, hydrates `req.auth`. Bumps `last_used_at` (best-effort, debug-logged on Redis miss).

### 5.10 — CSRF guard middleware

**WHAT IT DOES:** Double-submit verification on every state-changing route under cookie auth. Cookie + `x-csrf-token` header must match.

### 5.11 — Tenant context helpers

**WHAT IT DOES:** `withTenantSession(prisma, {orgId}, fn)` sets `app.org_id` GUC for one Prisma transaction. Used at every drain entry point + every authenticated tenant-scoped write.
**APPEARS IN FLOW:** Flow 06 · RLS

### 5.12 — WS publisher

**WHAT IT DOES:** `publishWsEvent(orgId, event)` wraps the event in `{orgId, event}` envelope, publishes to Redis `ws:analytics` channel, dispatches to outbound webhook subscribers in parallel.
**APPEARS IN FLOW:** Flow 07 · Real-time

### 5.13 — WS gateway

**WHAT IT DOES:** Single Fastify-websocket route. Per-connection `ClientCtx { userId, scope, orgId, send }`. Redis subscriber filters envelope by `shouldDeliverToClient(client, envelope)` before fan-out. Investor-scope clients get `scopeForInvestor(event)` applied.
**APPEARS IN FLOW:** Flow 07 · Real-time

### 5.14 — Outbound webhook delivery worker

**WHAT IT DOES:** BullMQ worker. Dequeues a delivery, signs with subscriber's secret, POSTs with exponential backoff. Final fail → marks `outbound_webhook_deliveries.status = 'ABANDONED'` + logs with stable errorId. Sync `worker.on('failed')` handler.
**APPEARS IN FLOW:** Flow 07 · Real-time (7.4)

---

## B6 · External integrations

Third-party services. We do NOT own these.

### 6.1 — EazePay App platform

**WHAT IT'S FOR:** Source-of-truth for application-lifecycle events. Posts to our `/integration/eazepay-app/events` endpoint.
**APPEARS IN FLOW:** Flow 01 · Inbound (1.1)

### 6.2 — HighSale (EZ Check)

**WHAT IT'S FOR:** Credit-data orchestration. Pulls Experian/Equifax/TransUnion, normalises, posts the snapshot to our `/integration/highsale/snapshots` endpoint.
**APPEARS IN FLOW:** Flow 01 · Inbound (1.2)

### 6.3 — MiCamp

**WHAT IT'S FOR:** Card processing. Webhook-back on every successful processing event + reversal.
**APPEARS IN FLOW:** Flow 01 · Inbound (1.3)

### 6.4 — Pixie

**WHAT IT'S FOR:** Pre-qualification API. Usage events post-back to our metering endpoint.
**APPEARS IN FLOW:** Flow 01 · Inbound (1.4)

### 6.5 — Lender reporting APIs

**WHAT IT'S FOR:** Lenders that don't push events — we poll their reporting API every 15 min and normalise. Per-lender adapter in `apps/api/src/domains/lenders/adapter/`.
**APPEARS IN FLOW:** Flow 01 · Inbound (1.5)

### 6.6 — AWS KMS

**WHAT IT'S FOR:** Root key for the per-org DEK envelope. AWS encrypts/decrypts the wrapped DEK; we never see the root key plaintext.
**APPEARS IN FLOW:** Flow 05 · Encrypt (5.2)

### 6.7 — AWS S3

**WHAT IT'S FOR:** Export storage in production. Presigned URLs for download. Local-disk fallback in dev (and currently in degraded prod — see incident notes).
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.2)

### 6.8 — Google OAuth

**WHAT IT'S FOR:** SSO provider. PKCE flow, JWKS-signed `id_token` verification, alg pinned to RS256.
**APPEARS IN FLOW:** Auth (2.2)

### 6.9 — Railway hosting

**WHAT IT'S FOR:** Platform-as-a-service. 5 services: `web`, `api`, `intel` (worker fleet), `Redis`, `Postgres` (with timescaledb extension + postgres-volume for the WAL).

### 6.10 — Resend / Twilio (notifications)

**WHAT IT'S FOR:** Outcome email (Resend) + outcome SMS (Twilio) dispatched by the notification orchestrator. (Same orchestrator powers operator alert notifications.)

---

## B7 · Data model · DB tables

Every domain table. PostgreSQL with TimescaleDB hypertables for time-series.

### 7.1 — `webhook_events`

**WHAT IT'S FOR:** Source-of-truth for every inbound vendor event. Unique on `(org_id, source, idempotency_key)`. Raw payload column purged after 90 days by lifecycle worker.
**APPEARS IN FLOW:** Flow 02 · Verify (2.6)

### 7.2 — `applications`

**WHAT IT'S FOR:** One row per application lifecycle. Lifecycle: PENDING → SUBMITTED → IN_REVIEW → APPROVED → DECLINED → FUNDED. PII columns (`consumer_name_ciphertext`, `consumer_email_ciphertext`, `consumer_phone_ciphertext`) encrypted via per-org DEK; hash columns (`consumer_email_hash`, `consumer_phone_hash`) for lookup.
**APPEARS IN FLOW:** Flow 04 · Drain (4.2); Flow 08 · Surfacing

### 7.3 — `partners`

**WHAT IT'S FOR:** One row per merchant partner. `external_id` for vendor cross-reference. Industry, brand, status, commercial terms.

### 7.4 — `lender_decisions` + `lender_reporting_events`

**WHAT IT'S FOR:** Per-lender decision rows (one per quote) + post-funding reporting events (settled, paid, defaulted, hardship). Decisions feed the offer-stack on application detail; reporting events feed the lender-timeline.

### 7.5 — `revenue_events` · THE LEDGER

**WHAT IT'S FOR:** Append-only ledger of every dollar movement. TimescaleDB hypertable, partitioned by `effective_at`. Stream enum: ORIGINATION, PROCESSING, COMMISSION, REPAYMENT, REVERSAL. `(org_id, source, idempotency_key)` unique. eazepay_app role has REVOKE on UPDATE+DELETE — true immutability enforced at DB layer.
**APPEARS IN FLOW:** Flow 04 · Drain; Flow 10 · Lifecycle (reconciliation)

### 7.6 — `revenue_aggregations`

**WHAT IT'S FOR:** Pre-rolled-up per-partner per-month totals. Materialised by `aggregation.worker.ts` from the ledger. Drives dashboard reads without scanning the full ledger.

### 7.7 — `credit_enrichments`

**WHAT IT'S FOR:** HighSale snapshot landings. Wide table — every field HighSale emits (score, grades, lookup flags, qualification flags, credit profile, funding estimates, demographics).

### 7.8 — `pixie_metrics` + `micamp_processing_events` + `micamp_reversal_events`

**WHAT IT'S FOR:** Vendor-event raw tables. Pixie metrics is a TimescaleDB hypertable for time-series queries. Drives per-partner usage + processing fee surfaces.

### 7.9 — `users` + `memberships`

**WHAT IT'S FOR:** Authenticated users + per-org memberships. `users.role` is the legacy global role (kept for migration compat). `memberships.role` is the per-org role (ADMIN / OPERATOR / VIEWER / INVESTOR) and is the SECURITY-CRITICAL one (post-SEC-014).

### 7.10 — `organizations`

**WHAT IT'S FOR:** Tenant table. `slug` is unique URL identifier. `default` org is the bootstrap org for pre-tenant-context writes (now self-seeded by `getBootstrapOrgId` post 2026-05-24 incident).

### 7.11 — `refresh_tokens`

**WHAT IT'S FOR:** Refresh-token family. Rotation on every refresh; reuse detection triggers family revoke. Indexed by `family_id` for cheap "kill family" operations. Token storage = HMAC-keyed hash (`AuthRepository.hashRefresh`).

### 7.12 — `api_tokens`

**WHAT IT'S FOR:** PAT storage. `prefix` is the lookup key; `hashed_secret` is the constant-time-compare value. Per-token scopes, expiry, last_used_at.

### 7.13 — `audit_logs`

**WHAT IT'S FOR:** Compliance-grade append-only trail. Every actor action. PII-free metadata by contract. SOC 2 CC7.3 evidence. REVOKE UPDATE/DELETE for eazepay_app role.
**APPEARS IN FLOW:** Flow 12 · Tracking

### 7.14 — `outbox_events`

**WHAT IT'S FOR:** Transactional outbox for cross-system writes. PENDING → SENT → DLQ states. Sweeper picks up pending rows.
**APPEARS IN FLOW:** Flow 04 · Drain (4.5, 4.6)

### 7.15 — `outbound_webhook_subscriptions` + `outbound_webhook_deliveries`

**WHAT IT'S FOR:** Customer-configured webhook destinations. Subscriptions filter by event-type. Deliveries are per-attempt rows (BullMQ-backed delivery worker writes here).

### 7.16 — `tenant_encryption_keys`

**WHAT IT'S FOR:** Per-org DEK material (KMS-wrapped). One active row per org. Rotation produces a new active row + leaves old rows for backward-decrypt.
**APPEARS IN FLOW:** Flow 05 · Encrypt (5.1)

### 7.17 — `webhook_credentials`

**WHAT IT'S FOR:** Per-tenant webhook secret rotation (deferred SEC-005 implementation target). Today still env-var-based; this table is the future home.

### 7.18 — `eazepay_app_quarantine`

**WHAT IT'S FOR:** EazePay App events whose brand body field doesn't map to any org. Operator triages via `/platform/quarantine`.
**APPEARS IN FLOW:** Flow 03 · Quarantine (3.1)

### 7.19 — `exports`

**WHAT IT'S FOR:** One row per export job. Status, format, filter, signed URL, expiry.

### 7.20 — `scheduled_reports`

**WHAT IT'S FOR:** Cron-driven report dispatch config. Next_run_at + notification channel.

### 7.21 — `alert_rules` + `alerts`

**WHAT IT'S FOR:** Rules = config; alerts = fired events. State machine: NEW → ACKNOWLEDGED → RESOLVED. Auto-resolve when metric returns to COOL.

### 7.22 — `rtbf_requests`

**WHAT IT'S FOR:** One row per RTBF submission. PENDING → PROCESSING → COMPLETED | FAILED. Carries `applications_scrubbed` count post-completion. `email_hash` unique on `(emailHash) WHERE status IN ('PENDING','PROCESSING')`.
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.4)

### 7.23 — `notes` + `tags`

**WHAT IT'S FOR:** Operator-annotated metadata on applications / customers / partners.

### 7.24 — `user_invitations`

**WHAT IT'S FOR:** One-time-use tokens for inviting users to an org. `token_hash` is the lookup; `accepted_at` flips on consumption. RLS bypass via `app.invitation_lookup = 'true'` GUC for the unauthenticated accept flow.

### 7.25 — `notification_channels`

**WHAT IT'S FOR:** Where to send alerts + scheduled reports + invitation emails. Slack webhook, email, SMS, custom HTTPS.

---

## B8 · Multi-tenant isolation

How one Postgres + Redis + Fastify process serves N tenants without leakage.

### 8.1 — RLS at the DB role

**WHAT IT DOES:** Runtime connects as `eazepay_app NOBYPASSRLS`. Every query is subject to the policies. Application-layer `where: { orgId }` is the first defence; RLS is the backstop.
**APPEARS IN FLOW:** Flow 06 · RLS

### 8.2 — `app.org_id` GUC

**WHAT IT DOES:** `SET LOCAL app.org_id = '<uuid>'` at the start of every tenant-scoped transaction. RLS policies read this via `current_setting('app.org_id', TRUE)`. Unset between requests.
**APPEARS IN FLOW:** Flow 06 · RLS (6.2)

### 8.3 — `app.platform_staff` bypass GUC

**WHAT IT DOES:** Set to `'true'` for cross-tenant platform-staff routes. Every bypass writes a `PLATFORM_CROSS_TENANT_ACCESS` audit row so the bypass is never silent.
**APPEARS IN FLOW:** Flow 06 · RLS

### 8.4 — Application-layer `orgId` predicates

**WHAT IT DOES:** Every Prisma `where: { ..., orgId }` + every raw-SQL `WHERE org_id = $1`. Belt-and-braces with RLS.

### 8.5 — WS per-tenant envelope filter

**WHAT IT DOES:** `publishWsEvent(orgId, event)` envelope; `shouldDeliverToClient(client, envelope)` per-client filter. Platform staff (orgId=null) see everything; tenant-scoped clients see only their orgId.
**APPEARS IN FLOW:** Flow 07 · Real-time

### 8.6 — Per-org DEK

**WHAT IT DOES:** Encryption material isolated per org. An exfiltrated DEK only unlocks ONE org's PII. AAD binding (SEC-006 deferred) will additionally make ciphertext non-portable across rows.
**APPEARS IN FLOW:** Flow 05 · Encrypt

### 8.7 — Membership re-check on every request

**WHAT IT DOES:** `requireAuth` re-verifies `memberships(userId, orgId)` on every request (skipped for platform staff). A user removed from an org loses access within one request, not within JWT_ACCESS_TTL.
**APPEARS IN FLOW:** Auth (2.7)

---

## B9 · Observability + compliance

Every action leaves a trail. Every metric is bounded. Every secret is provisioned through a documented path.

### 9.1 — Audit log

**WHAT IT'S FOR:** Compliance-grade trail. ~70 action types. PII-free by contract. Immutable at the DB role.
**APPEARS IN FLOW:** Flow 12 · Tracking (12.1)

### 9.2 — Alert engine

**WHAT IT'S FOR:** Self-service ops monitoring. Rule-driven. Auto-resolve.
**APPEARS IN FLOW:** Flow 12 · Tracking (12.2)

### 9.3 — Metrics endpoint

**WHAT IT'S FOR:** Prometheus scrape target. Bearer-token-gated.

### 9.4 — Slow-query log

**WHAT IT'S FOR:** Prisma `$on('query')` warns at `DATABASE_SLOW_QUERY_LOG_MS` threshold. Hot-spot identification.

### 9.5 — RTBF cryptoshred

**WHAT IT'S FOR:** GDPR Art. 17 + APP 12/13 compliance. Cryptographically irrecoverable PII deletion while preserving financial/regulatory trail.
**APPEARS IN FLOW:** Flow 09 · Operator actions (9.4)

### 9.6 — SOC 2 mapping

The codebase calls out SOC 2 controls inline at every relevant boundary. CC6.1 (logical access — RLS + RBAC), CC6.6 (idempotency-key enforcement), CC7.2 (slow-query monitoring), CC7.3 (audit log immutability), CC8.1 (change management).

### 9.7 — RTBF + retention runbook

**WHAT IT'S FOR:** Per-data-class retention policy + scrub schedule. Webhook payloads 90d, refresh tokens 7d, audit logs 7y, ledger 7y.

---

## Cross-references

- **Live URLs**: see `https://eaze-intelligence.up.railway.app` (web), `https://api-production-2792.up.railway.app` (api)
- **Repo**: https://github.com/Brodie-Eaze/eazepay-intelligence
- **Deferred work**: `docs/architecture/adr/ADR-006-deferred-security-hardening.md` (SEC-005 per-tenant webhook secrets · SEC-006 envelope AAD binding)
- **Operator runbook**: `docs/RUNBOOK.md`
- **Architecture**: `docs/architecture/data-warehouse-overview.md`

---

_Doc generated 2026-05-24 · format-matched to the EazePay platform engineering reference._
