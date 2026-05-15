# EazePay Intelligence — Integration Completeness Audit

Audit date: 2026-05-15
Scope: every inbound + outbound integration surface the warehouse needs, wired vs. stub.

---

## Inbound (vendor → us)

### 1. EazePay App platform-sink — `POST /api/v1/integration/eazepay-app/events`

**Status:** present-stub (verifies and 202s, **does not persist**)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/integration/eazepay-app/eazepay-app.routes.ts:63-144`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/integration/eazepay-app/event-types.ts:24-35`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/integration/eazepay-app/envelope.schema.ts:38-52`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/integration/eazepay-app/brand-org-mapping.ts:39-47`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/server.ts:55,332` (route IS registered, despite the file-header claim that it isn't)
- `/Users/Brodie/EazePay Intelligence/apps/api/prisma/schema.prisma:106-110`
- `/Users/Brodie/EazePay Intelligence/docs/integration/eazepay-app-contract.md:121-138`

**Evidence (eazepay-app.routes.ts:128-142):**
```
// ─── Stub response ─────────────────────────────────────────────────
// TODO(next session): once `WebhookSource.EAZEPAY_APP` migration
// lands, replace this with the durable persistence + drain path
reply.status(202);
return { accepted: true, eventId: env_.eventId, eventType: env_.eventType,
  knownEventType: isKnownEazepayAppEventType(env_.eventType),
  idempotencyKey, persisted: false,
  note: 'Stub — persistence pending WebhookSource.EAZEPAY_APP migration.' };
```

**Evidence (schema.prisma:106-110) — enum is MISSING the App value:**
```
enum WebhookSource {
  BUZZPAY
  PIXIE
  MICAMP
}
```

**What's wired:** HMAC-SHA-256 verify against `EAZEPAY_APP_WEBHOOK_SECRET`, ±300s timestamp tolerance, idempotency-key header read, envelope Zod parse, header↔body cross-check, raw-body signing (P0 SEC-004 fix), 202 ack with `persisted: false` and `knownEventType` flag. Event-name catalogue, brand→org mapping, and route registration in `server.ts` are all wired.

**What's missing:**
- `WebhookSource.EAZEPAY_APP` Prisma enum value (and migration).
- Persistence to `webhook_events`.
- Audit-log row (`WEBHOOK_RECEIVED` not written).
- Redis SETNX idempotency dedupe.
- Outbox drain handlers for any of the 9 declared event types: `application.offers_presented`, `application.contracted`, `application.funded`, `application.declined`, `loan.repayment.collected`, `loan.repayment.failed`, `merchant.onboarded`, `merchant.status_changed`, `revenue.recorded`.
- Note: route file declares `loan.repayment.*` and `application.funded` but the contract doc (§ Event-type catalogue) explicitly removed them — loan-side data is lender-owned. Catalogue is out of sync with the documented contract.
- Note: contract names `commission.recorded`; code names `revenue.recorded`. Naming drift.
- `direct` brand still has `null` org mapping → quarantine path unimplemented.

**Blocker / dependency:** Prisma enum migration adding `EAZEPAY_APP` to `WebhookSource`, then mirror `verifyWebhookSignature` middleware for the per-eventType drain. App-side `SecretResolver` + `PLATFORM_SINK` subscription is the upstream prerequisite (tracked in contract doc § App-side TODO).

**Severity:** P0 — every App event accepted today is dropped on the floor.

---

### 2. HighSale snapshots — `POST /api/v1/integration/highsale/snapshots`

**Status:** present-fully-wired (single event type)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/integration/highsale/highsale.routes.ts:83-337` (ingest)
- Lines 355-538 (`GET /highsale/snapshots` list+aggregate)
- Lines 547-711 (`GET /highsale/snapshots/:id` 70-field detail)
- Lines 726-978 (`GET /highsale/snapshots/export` CSV/JSON)
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/server.ts:56,333`

**Evidence (highsale.routes.ts:164-310):** every field from the 70-field HighSale spec is mapped to a typed Prisma column — `score`, `decline_rate`, `confidence_score_bnpl`, `funding_estimate_consumer_loan`, 17 tradeline-detail counters, 3 adverse-event counters, ML score, 13 protected-class demographics, plus PII encrypted under per-org DEK (`encryptPII`), email/phone/DOB HMAC-hashed for analytical join, and the full payload mirrored to `raw_payload`.

**What's wired:**
- HMAC verify against `HIGHSALE_WEBHOOK_SECRET` (raw-body, ±300s).
- Idempotency on `(vertical, highsale_transaction_id)` via Prisma unique constraint.
- Vertical→Org slug resolution for medpay / tradepay / coachpay (422 on unknown).
- `CREDIT_SNAPSHOT_RECEIVED`, `PII_ACCESSED`, `DATA_EXPORTED`, `PROTECTED_CLASS_READ` audit rows.
- Protected-class fields persisted; access gated on ADMIN role.

**What's missing:**
- **`WebhookSource.HIGHSALE` enum value is NOT in the Prisma schema** (still just `BUZZPAY | PIXIE | MICAMP`). The HighSale path persists directly to `credit_enrichments` rather than going through `webhook_events`, so it works — but the doc and `docs/integration/eazepay-app-contract.md:165` reference a "HIGHSALE source enum queued" that never landed. Inconsistent with the BuzzPay/Pixie/MiCamp pattern; harder to query "all inbound webhook traffic by source."
- `application_id` correlation: `applicationId` is hard-coded `null` on insert; correlation token from App is documented but not yet stitched. Fallback fuzzy match on (email_hash + dob + created_at) is not implemented either.
- No replay/backfill endpoint.

**Blocker / dependency:** none for the snapshot path itself; the App-side HighSale-client change (passing `application_id` as correlation token) is the prerequisite for stitching.

---

### 3. MiCamp — `POST /api/v1/webhooks/micamp/{processing,reversal}`

**Status:** present-fully-wired

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/webhooks/webhook.routes.ts:76-86`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/webhooks/webhook.service.ts:188-236`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/webhooks/webhook.schemas.ts:31-47`

**Evidence (webhook.routes.ts:76-86):**
```
for (const evt of ['processing', 'reversal'] as const) {
  app.post(`/webhooks/micamp/${evt}`,
    { preHandler: verifyWebhookSignature(WebhookSource.MICAMP),
      config: webhookRateLimit(), ... }, ingest); }
```

**What's wired:**
- Both event types (`processing`, `reversal`) → HMAC verify → outbox-pattern persistence → BullMQ drain → `RevenueEvent` insert. 50/50 split for processing fee, negative reversal entry. Currency override per-event (no more hardcoded AUD).
- `revenue.event` outbound webhook fan-out (via `publishWsEvent` in `recordRevenue`).

**What's missing:** nothing critical. No `merchant.*` event types — MiCamp is purely a revenue-feed source.

---

### 4. Pixie — `POST /api/v1/webhooks/pixie/usage`

**Status:** present-fully-wired

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/webhooks/webhook.routes.ts:66-74`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/webhooks/webhook.service.ts` (Pixie handler section, recordRevenue at 155-186)
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/webhooks/webhook.schemas.ts:17-27`

**What's wired:** HMAC verify against `PIXIE_WEBHOOK_SECRET`, outbox persistence, drain into `pixie_metrics` row, derived margin → `RevenueEvent` (PIXIE_MARGIN type), `pixie.usage_reported` outbound fan-out.

**What's missing:** only one event type (`usage`) is wired; no `pixie.breakpoint_changed` or similar lifecycle events. That looks intentional — Pixie's surface is single-purpose.

---

### 5. Lender API pull adapters — `apps/api/src/workers/lender_*.worker.ts`

**Status:** missing entirely

**Files:** workers directory contains: `export.worker.ts`, `lifecycle.worker.ts`, `revenue.worker.ts`, `alert.worker.ts`, `aggregation.worker.ts`, `webhook.worker.ts`, `outbox.worker.ts`, `webhook-delivery.worker.ts`. **No `lender_*.worker.ts` file exists.**

**Evidence (eazepay-app-contract.md:238-262):**
```
## Phase 2.7 — Lender reporting adapters
... To bring it into Intelligence we build **one adapter per lender** ...
- _(TBD — one row per lender once we have signed integrations)_
... The lender adapters do NOT use the App webhook contract — they are
a parallel ingestion plane in `apps/api/src/domains/lender-adapters/`
(stub forthcoming).
```

**What's wired:** `apps/api/src/domains/lenders/lender.routes.ts` exposes 3 read-only analytics endpoints (`/lenders/waterfall`, `/lenders`, `/lenders/:name/performance`) over data already in `lender_decisions`. No outbound puller, no `lender_reporting_*` tables, no `apps/api/src/domains/lender-adapters/` directory.

**What's missing:**
- Every lender adapter (OAuth/API-key client, polling cursor, `modified_since` delta logic).
- `lender_reporting_*` mirror tables in Prisma.
- Join logic on lender-side reference id from `application.routed_to_lender` event (which itself isn't emitted).
- Reconciliation between App's `application.contracted` and lender's funded-loan row.

**Blocker / dependency:** zero lender contracts signed per the doc placeholder. Pure design phase.

**Severity:** known-deferred (Phase 2.7).

---

### 6. PAT ingestion — `POST /api/v1/ingestion/events` and per-target

**Status:** partial (covers MiCamp + Pixie only; BuzzPay-shaped paths retired without replacement)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/ingestion/ingestion.routes.ts:72-88,144-163,176-239`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/server.ts:54,331`

**Evidence (ingestion.routes.ts:67-88):**
```
// BUZZPAY-shaped ingestion targets (applications / lender-decisions /
// funding-status / clawbacks) retired — those events now flow through
// the EazePay App integration sink at /api/v1/integration/eazepay-app/events.
const TARGETS: Record<string, IngestionTarget> = {
  'pixie-usage': { source: WebhookSource.PIXIE, eventType: 'usage', ... },
  'micamp-processing': { source: WebhookSource.MICAMP, eventType: 'processing', ... },
  'micamp-reversals': { source: WebhookSource.MICAMP, eventType: 'reversal', ... },
};
```

**What's wired:**
- `POST /ingestion/pixie-usage`, `POST /ingestion/micamp-processing`, `POST /ingestion/micamp-reversals` — typed per-target.
- `POST /ingestion/events` — generic escape hatch (any `WebhookSource` enum value + free `eventType`).
- `POST /ingestion/:target/bulk` — batch with per-row idempotency, audit-suppressed per-row + single batch audit.
- PAT-bearer or session-cookie auth + `WRITE` scope + CSRF + ingestion-tier rate limit.
- `INGESTION_REQUEST` / `INGESTION_REJECTED` audit rows.

**What's missing:**
- **`applications`, `lender-decisions`, `funding-status`, `clawbacks` targets are retired but the EazePay App sink that should replace them is still a stub.** The generic `/ingestion/events` endpoint accepts any `WebhookSource` payload, but since `EAZEPAY_APP` is not in the enum, you can't even send App events through this back door.
- Aurean-AI and Aurean-Recruitment are documented as feeding through `/api/v1/ingestion/*` PAT-driven flows (per `brand-org-mapping.ts:23`), but no `aurean-*` targets exist in `TARGETS`. They'd have to use the generic `/ingestion/events` with whatever `WebhookSource` — and no `WebhookSource.AUREAN` value exists either.

**Blocker / dependency:** EazePay App sink completion (item 1), plus a decision on whether Aurean orgs need their own source enum or ride the generic escape hatch.

---

## Outbound (us → vendor/subscriber)

### 7. Outbound webhook subscriptions

**Status:** present-fully-wired

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/outbound-webhooks/outbound-webhook.service.ts:118-246`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/outbound-webhooks/outbound-webhook.routes.ts`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/utils/ws-publisher.ts:124-140`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/workers/webhook-delivery.worker.ts`

**Evidence (outbound-webhook.service.ts:81-116 SSRF guard):**
```
export async function assertPublicHostname(urlString: string): Promise<void> {
  ...
  if (net.isIP(host)) {
    const isPrivate = net.isIPv6(host) ? isPrivateIPv6(host) : isPrivateIPv4(host);
    if (isPrivate) throw new Error('webhook.url.private_address'); ... }
  records = await lookup(host, { all: true });
  ...
```

**What's wired:**
- 9 event types accepted at subscription create (`outbound-webhook.routes.ts:13-23`): `application.created`, `application.status_changed`, `lender.decision`, `funding.completed`, `funding.failed`, `revenue.event`, `pixie.usage_reported`, `partner.onboarded`, `partner.tier_changed`.
- HMAC-signed POST (`X-Eazepay-Signature`, `X-Eazepay-Timestamp`, `X-Eazepay-Event-Type`).
- **SSRF guard SEC-110** — RFC1918, loopback, link-local (incl. 169.254.169.254 AWS metadata), CGN, multicast, IPv6 unique-local, IPv4-mapped IPv6, multi-A-record handling. Applied at both subscription create AND delivery time. `redirect: 'manual'` so a 302 to a private IP cannot defeat the guard.
- BullMQ retry on non-2xx, `WebhookDeliveryStatus.FAILED → ABANDONED` after exhaustion.
- Test-delivery endpoint, listing, replay-from-history, manual delete.
- Fan-out via `publishWsEvent` (`ws-publisher.ts:134`) — every WS event also goes to subscriber URLs.

**What's missing:**
- **Subscriber-side HMAC verification is broken by design** (per file comment line 215): the secret is one-way-hashed at storage; the sender signs with the *hash* as key, not the original secret. Subscribers can only verify if you ship them the hashed secret out-of-band. Improvement noted in source ("store encrypted secret instead of hash") but not done.
- No event-type for `clawback.recorded` (referenced in App contract but not in the union here either — see naming drift).

---

### 8. Scheduled reports — delivery channel

**Status:** partial (scheduling CRUD + run-now wired; the actual scheduler + delivery worker is not implemented)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/scheduled-reports/scheduled-report.routes.ts:122-136`

**Evidence (scheduled-report.routes.ts:1-9):**
```
* A `ScheduledReport` is a (cron, report-type, params, channel) tuple. A worker
* (run on cron from the host platform — out of scope for this PR) iterates rows
* where `nextRunAt < now()`, kicks off the export, posts the artefact to the
* channel, and updates `lastRunAt` + `nextRunAt`.
```

**What's wired:** CRUD on `scheduled_reports`, manual `/run` creating a `report_runs` row with `status=PENDING`, `cron_expression` stored as opaque string, optional `channelId` foreign-key to `NotificationChannel`.

**What's missing:**
- No scheduler worker reading `WHERE nextRunAt < now()` — `nextRunAt` is never updated by code anywhere.
- No artefact-to-channel delivery path. `ReportRun` rows are inserted as PENDING and never transitioned.
- `cronExpression` not validated.

**Blocker / dependency:** needs a `scheduled-report.worker.ts` that picks up PENDING runs, calls `ExportService`, posts to channel.

---

### 9. Exports — formats and storage

**Status:** partial (CSV+JSON wired; XLSX downgraded; storage is local-disk only)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/exports/export.service.ts:1-244`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/workers/export.worker.ts`

**Evidence (export.service.ts:5-12, 80-89):**
```
* Output strategy: write to local FS under ./tmp/exports/<id>.<ext>. In
* production this swaps to S3 with a presigned URL — the public download
* endpoint is the same shape, only the storage backend changes.
const STORAGE_ROOT = process.env.EXPORT_STORAGE_DIR ?? join(process.cwd(), 'tmp', 'exports');
...
case ExportFormat.XLSX:
  return 'csv'; // xlsx-writer pending
```

**What's wired:** 6 export types (CUSTOMERS, APPLICATIONS, LENDER_DECISIONS, REVENUE_LEDGER, PARTNERS, AUDIT_LOG). CSV + JSON bodies. 24h TTL. Reader/writer Prisma split. `expiresAt` set. PII-hash-only output for customer email/phone.

**What's missing:**
- **No S3 backend** — `STORAGE_ROOT` always local. A multi-pod deploy means downloads only work from the pod that created the export.
- **XLSX silently downgrades to CSV-with-extension** (`extensionFor` returns `'csv'` for XLSX). No actual xlsx writer.
- No presigned-URL endpoint or signing helper.

**Blocker / dependency:** S3 client + bucket policy + signing keys; xlsx writer (e.g. `exceljs`).

---

### 10. Alerts — delivery channels

**Status:** present-stub (IN_APP delivers; WEBHOOK, EMAIL, SLACK do not)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/domains/alerts/alert.dispatcher.ts:73-126`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/workers/alert.worker.ts`

**Evidence (alert.dispatcher.ts:76-99):**
```
case 'IN_APP':
  delivered = true; break;
case 'WEBHOOK':
  delivered = false;
  reason = 'webhook_dispatch_not_implemented';
  break;
case 'EMAIL':
case 'SLACK':
  delivered = false;
  reason = 'integration_pending';
  break;
```

**What's wired:** Rule evaluation, state machine OPEN→ACK→RESOLVED, `IN_APP` channel (which is a no-op because the Alert row itself is the in-app surface), `ALERT_FIRED` audit row tagged with `dispatched: false` + explicit `reason` for failure modes. Channels persisted as `NotificationChannel` rows.

**What's missing:**
- WEBHOOK should enqueue an `OUTBOUND_DELIVERY` job via `OutboundWebhookService` (item 7) — comment explicitly notes this gap.
- EMAIL channel — no call into `sendEmail` (the Resend wrapper exists, item 13).
- SLACK channel — no Slack integration anywhere in the codebase.

**Blocker / dependency:** plumbing alone — outbound webhook + email services are wired; the dispatcher just needs to call them.

---

### 11. Audit log streaming — SIEM / external-log integration

**Status:** missing entirely

**Files:** none.

**Evidence:** `rg "SIEM|siem|audit.streaming|datadog|splunk"` finds only two passive references in comments (`server.ts:71`, `password.ts:28`) saying "downstream SIEM correlation." No actual streamer, no `audit_log.stream.ts`, no Kinesis/Firehose/Kafka sink, no Datadog/Splunk HEC adapter.

**What's wired:** `audit_logs` table in Postgres, `writeAuditLog()` helper used throughout. Read-back via `GET /admin/audit-log` and `Export.AUDIT_LOG`.

**What's missing:**
- Real-time tail-and-ship to an external sink. Today the only way out is CSV export every N hours.
- Long-term retention beyond Postgres (compliance window typically 7y; Postgres isn't the cheapest place to keep it).

**Blocker / dependency:** decision on which SIEM / log lake to target (Datadog, Splunk, ELK, S3-via-Firehose). No upstream blocker.

**Severity:** medium — SOC 2 CC7.2 / CC7.3 prefer it, not strictly required.

---

## Cross-cutting

### 12. AWS KMS — production wiring

**Status:** present-fully-wired

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/kms/kms-factory.ts:35-70`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/kms/aws-kms-client.ts:49-139`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/kms/local-kms-client.ts`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/kms/tenant-dek.ts`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/kms/dek-cache.ts`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/config/env.ts:155-232` (production-mode validation)

**Evidence (kms-factory.ts:48-67):**
```
export async function bootstrapKms(): Promise<{ driver: KmsDriver; client: KmsClient }> {
  const driver = resolveKmsDriver();
  if (driver === 'aws') {
    if (!process.env['AWS_KMS_KEY_ARN']) throw new Error('AWS_KMS_KEY_ARN is required when KMS driver is aws');
    const { AwsKmsClient } = await import('./aws-kms-client.js');
    client = new AwsKmsClient();
  } else { ... }
  setKmsClient(client); return { driver, client };
}
```

**What's wired:** Factory selects `AwsKmsClient` on `KMS_DRIVER=aws` or `NODE_ENV=production`. AWS SDK with credential chain. `generateDataKey`, `wrapDataKey`, `unwrapDataKey`, `scheduleKeyDeletion`, `disableKey`. Region default `ap-southeast-2`. DekCache for 1h DEK reuse. Production env validator fails fast if `AWS_KMS_KEY_ARN` unset.

**What's missing:** per-org CMKs supported by interface but mapping table not visible — verify in tenant-dek.ts that orgs each have their own `kekKeyId` rather than a platform-wide ARN.

---

### 13. Resend (email)

**Status:** present-fully-wired (with dev-mode fallback)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/email/email.service.ts`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/config/env.ts:137-140`

**Evidence (email.service.ts:42-62):** when `RESEND_API_KEY` unset → log to console; otherwise direct `fetch` against `https://api.resend.com/emails` with bearer auth.

**What's wired:** transactional send, dev console fallback, structured logging.

**What's missing:** templating, batching, bounce/complaint webhook handling (no inbound Resend webhook).

---

### 14. OTel tracing

**Status:** present-fully-wired (opt-in via env)

**Files:**
- `/Users/Brodie/EazePay Intelligence/apps/api/src/config/telemetry.ts:34-130`
- `/Users/Brodie/EazePay Intelligence/apps/api/src/shared/utils/tracing.ts`

**Evidence (telemetry.ts:74-77, 85-101):**
```
const exporter = new OTLPTraceExporter({
  url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
  ...(headers ? { headers } : {}),
});
sdk = new NodeSDK({ resource, traceExporter: exporter,
  instrumentations: [ getNodeAutoInstrumentations({ ... fastify, pg, ioredis on; fs, dns off }) ] });
```

**What's wired:** OTLP/HTTP exporter, auto-instrumentations for Fastify/pg/ioredis/HTTP/BullMQ, W3C Trace Context propagation, per-process `service.name`, SIGTERM flush. Opt-in via `OTEL_ENABLED=true`+`OTEL_EXPORTER_OTLP_ENDPOINT`.

**What's missing:** metrics + logs exporters (only traces wired). No specific APM-vendor adapter — that's deliberate (OTLP is vendor-neutral).

---

## Summary table

| # | Integration | Status | Critical gap |
|---|-------------|--------|--------------|
| 1 | EazePay App sink | stub | Persistence path; enum migration; drain handlers for 9 event types |
| 2 | HighSale snapshots | full | Missing `WebhookSource.HIGHSALE` enum; app_id correlation |
| 3 | MiCamp webhooks | full | — |
| 4 | Pixie webhooks | full | — |
| 5 | Lender adapters | missing | All of it — Phase 2.7 |
| 6 | PAT `/ingestion/*` | partial | BuzzPay paths retired; replacement (App sink) is stub |
| 7 | Outbound webhooks | full | Subscriber-side HMAC verify model is broken-by-design |
| 8 | Scheduled reports | partial | No scheduler worker; no channel delivery |
| 9 | Exports | partial | No S3; XLSX silently downgrades to CSV |
| 10 | Alerts | stub | WEBHOOK/EMAIL/SLACK all return `delivered:false` |
| 11 | Audit-log streaming | missing | No SIEM sink |
| 12 | AWS KMS | full | — |
| 13 | Resend email | full | — |
| 14 | OTel tracing | full | Traces only (metrics+logs not exported) |

**P0 blockers for the App→Intelligence integration to actually move data:** (1) `WebhookSource.EAZEPAY_APP` enum + migration, (2) replace stub 202 with `verifyWebhookSignature`-mirroring persistence, (3) drain handlers per event type into `applications` / `lender_decisions` / `revenue_events`. Everything required for steps 1-3 is already designed in `docs/integration/eazepay-app-contract.md` and partially scaffolded in the route file's TODO.

**Single largest hidden risk:** the EazePay App route IS registered in `server.ts:332` despite the route-file header explicitly claiming it is not. A production deploy today returns 202 for every signed App webhook, the App-side dispatcher marks the delivery succeeded, and the data is never written. This is silently-passing-but-dropping behaviour, worst kind of failure mode.
