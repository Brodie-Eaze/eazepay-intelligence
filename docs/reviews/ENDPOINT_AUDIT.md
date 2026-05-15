# Platform endpoint audit — what's built, what's missing

> Date: 2026-05-15
> Three parallel audit agents (endpoint-inventory, warehouse-gap-analysis, integration-completeness) reviewed every route, every integration, every worker. Findings consolidated below.

## Top-line

- **30+ domains, ~150 HTTP endpoints already built** (full inventory below).
- **20 gaps identified** (`GAP-100..120`), 7 critical, 6 high, 4 medium, 3 nice-to-have.
- **One P0 silent-data-loss bug**: EazePay App webhook sink is registered but returns `persisted: false` — App dispatcher gets 202 successes while every event is dropped. Blocks medpay/tradepay/coachpay entirely.

## Critical gaps (block calling this a "fully functional warehouse")

### GAP-100 · EazePay App Plane 1 stub

**Status:** Route registered, HMAC verifies, returns `{ persisted: false }`. **Silently dropping every App event.**
**Fix:** Add `WebhookSource.EAZEPAY_APP` enum, persist via existing outbox pattern, drain handlers for the 6 contracted event types. Blocks all 3 BNPL verticals.
**Effort:** Large.

### GAP-101 · Lender Adapter Plane 3

**Status:** Directory doesn't exist. Zero code.
**Fix:** Adapter interface + per-lender adapters + `LenderReportingEvent` model + polling worker. Blocks every loan-performance KPI.
**Effort:** Large.

### GAP-102 · ApplicationStatus missing `OFFERED`/`CONTRACTED`

**Status:** Enum has PENDING/SUBMITTED/IN_REVIEW/APPROVED/DECLINED/FUNDED. App contract uses OFFERED, CONTRACTED.
**Fix:** Migration adds the values. Required for GAP-100 drain handlers.
**Effort:** Small.

### GAP-103 · Aurean AI typed event schema

**Status:** Free-form `eventType: string` only. No `AUREAN_AI` enum value.
**Fix:** Zod schemas for `inference.completed` / `scoring.run` / `revenue.recorded` + drain handler + read endpoint for KPIs.
**Effort:** Medium.

### GAP-104 · Aurean Recruitment typed event schema

**Status:** Same as GAP-103.
**Fix:** Zod schemas for `placement.completed` / `commission.accrued` / `pipeline.stage_changed` + drain + KPI endpoint.
**Effort:** Medium.

### GAP-105 · HighSale as-a-business operational events

**Status:** `WebhookSource` has no `HIGHSALE` value. Existing `/integration/highsale/snapshots` is Plane 2 only.
**Fix:** Add `HIGHSALE` to enum + typed `inquiry.submitted` / `snapshot.delivered` / `risk_band.assigned` schemas.
**Effort:** Small.

### GAP-106 · Application correlation linker

**Status:** `credit_enrichments.applicationId` is always null. No correlation worker, no admin reconcile endpoint.
**Fix:** Background worker matches enrichments to applications via externalApplicationId / fuzzy match. Admin `/credit-enrichments/unparented` + `/reconcile`.
**Effort:** Medium.

### GAP-107 · Protected-class read permission gate

**Status:** `GET /integration/highsale/snapshots/:id` returns demographics block to any authenticated user. FCRA risk.
**Fix:** `requirePermission('protected_class_read')` middleware + audit row per access.
**Effort:** Small.

## High priority

### GAP-108 · Per-org analytics endpoints

**Status:** Every analytics route is platform-wide global, no orgId filter. Becomes cross-tenant leak when second user joins.
**Fix:** Move under `/o/:orgSlug/`, thread `orgId` into AnalyticsRepository/Service.
**Effort:** Medium.

### GAP-109 · S3 export delivery

**Status:** Exports write to local container filesystem. Lost on every Railway redeploy.
**Fix:** S3 upload + presigned URL on download.
**Effort:** Medium.

### GAP-110 · Scheduled report worker

**Status:** CRUD exists, ReportRun rows created, but no worker advances `nextRunAt` or executes runs.
**Fix:** `scheduled-report.worker.ts` polls + enqueues + parses cron.
**Effort:** Medium.

### GAP-111 · RTBF incomplete — `credit_enrichments` not scrubbed

**Status:** RTBF scrubs `applications` only. HighSale PII echo survives erasure.
**Fix:** Extend `RtbfService.processInner` to scrub `credit_enrichments` rows on emailHash match.
**Effort:** Small.

### GAP-112 · `/platform/reconciliation`

**Status:** Listed in code comments as pending. Doesn't exist.
**Fix:** Cross-org revenue integrity endpoint for platform staff.
**Effort:** Small.

### GAP-113 · Audit log org filter + AUDIT_LOG export

**Status:** `/audit-logs` returns all orgs' rows. `AUDIT_LOG` ExportType exists but no handler in export.service.
**Fix:** orgId filter + implement AUDIT_LOG arm in `gatherRows`.
**Effort:** Small.

## Medium priority

### GAP-114 · `/platform/orgs/:id/impersonate-token`

Listed pending. SUPER-only short-lived PAT for incident debugging. **Small.**

### GAP-115 · Outbound webhook subscription orgId scoping

`WebhookSubscription` is userId-scoped, not org-scoped. Cross-tenant fan-out risk. **Small.**

### GAP-116 · dbt CI + read-replica DSN

PLATFORM_V2 Phase 2.2 + 2.4. Unblocks dbt nightly builds + replica read offloading. **Medium.**

### GAP-117 · HighSale snapshot async export

Synchronous endpoint times out at >10k rows. Add async path via Export job system. **Small.**

## Nice-to-have

### GAP-118 · EazePay App replay endpoint

Cold-start recovery after fresh deploy. Depends on GAP-100. **Small.**

### GAP-119 · Customer detail lender-side data

Depends on GAP-101 landing. **Small (once 101 ships).**

### GAP-120 · `brand=direct` quarantine review surface

Admin endpoint to review + reclassify quarantined events. Depends on GAP-100. **Small.**

## What's already complete

- Plane 2 HighSale credit-data snapshots (70 fields) — live
- Plane 4 MiCamp processing/reversal — live
- Plane 4 Pixie usage — live
- Portfolio domain (P&L, revenue channels, unit econ, cohorts, headcount) for all 7 businesses — live
- Revenue ledger / streams / reconciliation — live
- Customer book / detail / PII reveal / credit enrichments — live
- Async export (CSV/JSON) for 5 of 6 types — live
- Outbound webhook subscriptions + delivery + replay (post-SEC-110) — live
- Alert rules + state machine — live
- RTBF for applications — live
- Platform: org CRUD, DEK rotate, cryptoshred, sessions, health — live
- Admin: webhook events, audit logs, data-source stats, warehouse landscape — live
- Per-tenant DEK envelope encryption infrastructure — live (write-path adoption is Phase 2)
- RLS policies on 6 tables — live (extension is Phase 1)

## Detailed agent reports

Full reports are in the agent run transcripts at:

- `_audit_existing_endpoints.md` (inventory — 4000 words)
- `_audit_missing_endpoints.md` (gaps — 4500 words)
- `_audit_integrations.md` (integration completeness — 3000 words)

(The agents' raw output is captured in this session's task transcripts; this file is the synthesised summary.)
