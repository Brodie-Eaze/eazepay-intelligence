# Phase progress — security hardening + multi-tenant retrofit

> Authoritative tracker for the work captured in [`docs/reviews/HARDENING.md`](reviews/HARDENING.md) (106 findings
> from 5 review agents) and [`docs/reviews/ENDPOINT_AUDIT.md`](reviews/ENDPOINT_AUDIT.md) (20 endpoint gaps).
> Last updated: 2026-05-15.

All Phase 0–7 work + GAP-100/106/110/112/113/114/117/118/120 collapsed onto **one stacked PR** —
`phase-1.5/callsite-retrofit-v2` — ready to merge to `main`. Production (`main`, commit `d8555ec`)
is untouched; merging this branch ships every item below in one go.

## ✅ Shipped on `phase-1.5/callsite-retrofit-v2`

### Phase 0 — Surgical security fixes (19 findings)

Raw-body HMAC, CSRF path-traversal fix, JWT secrets per kind, PAT pepper, LocalKMS prod guard,
SSRF allowlist, web tier security headers, env entropy assertions, `__Host-` cookies,
x-request-id validation, idempotency-key regex, generic decrypt errors.
Closes: CR-101/102/103/104, CR-108, SF-004/005/012/017/018, SEC-004/104/108/110/115/122/126/129/131/133, TD-121.

### Phase 1 — Multi-tenant schema retrofit

- `org_id` added to ~20 tenant tables (Phase 1).
- WebhookSource: + EAZEPAY_APP / HIGHSALE / AUREAN_AI / AUREAN_RECRUITMENT.
- ApplicationStatus: + OFFERED / CONTRACTED / QUARANTINE.
- Per-org unique constraints (Partner.externalId, RevenueEvent/WebhookEvent idempotency-key, Tag.name, CreditEnrichment.highsaleTransactionId).

### Phase 1.5 — Call-site orgId retrofit

- orgId threaded through every Prisma create/upsert/findUnique across ~20 files.
- `withTenantSession` helper for SET LOCAL `app.org_id` on every tenant-scoped tx.
- `ws-publisher` first-arg is now orgId.
- GAP-107 protected-class read gate (FCRA), GAP-111 RTBF credit_enrichments scrub (GDPR Art. 17 / APP 11).

### Phase 1.6 — RLS rollout

- `ENABLE ROW LEVEL SECURITY` + per-table `tenant_isolation` policy on every Phase-1 retrofitted table:
  partners, applications, lender*decisions, revenue_events, pixie_metrics, revenue_aggregations,
  webhook_events, outbox_events, exports, webhook_subscriptions, webhook_deliveries,
  refresh_tokens, notification_channels, alert_rules, alerts, notes, tags, tag_assignments,
  saved_views, scheduled_reports, report_runs, cases, rtbf_requests, credit_enrichments + 8 portfolio*\* tables.
- Policy: `org_id = current_setting('app.org_id') OR current_setting('app.platform_staff') = 'true'`.
- Surgical escapes for webhook_signature, outbox_sweeper, bearer_lookup, invitation_lookup.

### Phase 3 — Per-tenant DEK

- HighSale credit_enrichments PII writes use `encryptForOrg(prisma, plaintext, orgId)` — v2 envelopes.
- HighSale read paths dispatch via `decryptEnvelopeAuto` (v1 → legacy global key, v2 → per-org).
- Phase 3 continued: Application table read paths now use `decryptEnvelopeAuto` too.
- Background worker `pii-reencryption` walks v1 rows and re-encrypts under per-org DEK. Tunable batching.

### Phase 4a — JWT jti deny-list (logout-revokes-access-token)

- `/auth/logout` writes the access JWT's `jti` into Redis with TTL = remaining lifetime.
- `requireAuth` checks the deny-list on every request. Sub-ms Redis GET.

### Phase 4b — OAuth JWKS verification

- `oauth.routes` replaces Google's deprecated `/tokeninfo` HTTP call with local RS256 JWKS verification.
- 1-hour cache; force-refresh on kid miss; aud/iss/exp re-checked.
- 5s timeout on the JWKS fetch; 10s on the token exchange.

### Phase 4c — Refresh-token sessionId + OAuth PKCE

- New `RefreshToken.session_id`, backfilled := familyId for existing rows.
- Access JWT carries `sid` claim; `requireAuth` checks denySid deny-list.
- `/auth/sessions` enumerates active sessions; `/auth/sessions/:id DELETE` revokes one.
- OAuth: PKCE S256 with code_verifier in HMAC-signed `__Host-oauth_pkce` cookie.

### Phase 6 — Dependency upgrades

- @opentelemetry/sdk-node 0.54 → 0.218 (closes GHSA-q7rr-3cgh-j5r3 Prometheus DoS).
- fastify 4.28 → 4.29, next 14.2.13 → 14.2.35, pnpm.overrides for fast-uri / glob / undici.
- 33 → 20 CVEs; remaining 20 blocked behind next-major upgrades.

### Phase 7 — Silent-failure cleanup

- `writeAuditLog` accepts optional `tx` so audit + mutation rollback together (SF-009).
- Outbox DLQ: rows crossing `OUTBOX_MAX_ATTEMPTS` (default 10) get `dlqed_at` stamped + excluded from sweep (SF-006).
- /platform/outbox/dlq list + replay endpoints (STAFF read, SUPER replay).
- OAuth fetch timeouts (SF-011) — already-shipped under Phase 4b.
- Webhook-delivery abandon-marker logs with stable errorId instead of swallowing (SF-015).
- Rate-limit fail-closed on Redis failure (SF-003).

### MFA hardening

- Dedicated per-user MFA rate-limit bucket on `/auth/mfa/verify` + `/auth/mfa/disable` (5 / 90s).
- `USER_MFA_FAILED` audit row on every failed code (CR-106 + SEC-130).

### GAP-100 — EazePay App sink (was silently dropping medpay/tradepay/coachpay)

- HMAC verify → 2-layer idempotency (Redis SETNX + Postgres unique) → resolve org via brand → durable WebhookEvent + OutboxEvent in one tx.
- `EazepayAppProcessor` drain handlers: application.offers_presented / contracted / declined / funded, merchant.onboarded / status_changed, revenue.recorded, loan.repayment.\*.
- Per-org DEK on every PII write.
- Quarantine status for unmappable rows (unknown brand, unknown partner). Operator-replayable via /platform.

### GAP-112 — `/platform/reconciliation`

Cross-org STAFF-readable snapshot: revenue 7d, applications, webhooks processed, quarantined,
DLQ, active DEKs. health = OK / ATTENTION.

### GAP-114 — `/platform/orgs/:id/impersonate-token`

SUPER mints a short-lived (cap 30min) access JWT pinned to target orgId. Returns `sid` for
session revocation. PLATFORM_CROSS_TENANT_ACCESS audit row with reason + ttl.

### GAP-117 — HighSale snapshot export

`CREDIT_ENRICHMENTS` ExportType + handler — hashed identifiers + vertical + pulled timestamp.
PII columns OMITTED (protected-class gate applies).

### GAP-118 / GAP-120 — EazePay App quarantine triage

`GET /platform/eazepay-app/quarantine` lists quarantined events; `POST .../:id/replay` re-runs
drain (with optional reassignToOrgId for manual brand → org routing).

### GAP-110 — Scheduled report worker

Polls `scheduled_reports WHERE isActive AND nextRunAt <= now`, creates one Export + ReportRun
per due report, advances `nextRunAt` via inline cron parser (subset).

### GAP-106 — Application correlation linker

Walks `credit_enrichments WHERE applicationId IS NULL`, matches against applications on
`(orgId, externalApplicationId)` or `(orgId, consumerEmailHash)` within ±7 days.
Ambiguous matches flagged + skipped. Run as worker:correlation-linker.

### GAP-113 — Audit log org filter

`export.service.gatherRows` now requires `orgId`; AUDIT_LOG export filters out platform-level
rows. Tenant exports cannot leak other tenants' data even if RLS is bypassed on the worker.

### eazepay_app role runbook

`docs/runbooks/eazepay-app-role-deploy.md` documents the operator-applied SQL: CREATE ROLE
NOBYPASSRLS, REVOKE UPDATE/DELETE on audit_logs / revenue_events / webhook_events /
outbox_events; REVOKE DELETE on credit_enrichments; selective UPDATE on tenant_encryption_keys.
Not auto-applied — runs deliberately during a maintenance window.

### GAP-108 — Per-org analytics scope

All `/analytics/*` + `/revenue/*` + `/lenders/*` endpoints now derive
`orgId` from `req.auth.orgId` (set by login from the user's oldest
membership) and pass it to the repository layer. Every query filters
by orgId in WHERE clauses; cache keys are namespaced by orgId so
SET-EX races between tenants are impossible.

AnalyticsRepository, AnalyticsService, RevenueRepository, RevenueService,
LenderRepository, LenderService — every method signature now takes
`orgId` as its first argument. Routes fail-closed with a 400 if the
user has no active org. Platform-staff cross-org views are exclusively
on `/platform/*`.

### GAP-109 — S3 export delivery framework

New `apps/api/src/shared/storage/` directory with a clean interface +
two implementations:

- `LocalDiskStorage` (dev + tests; writes to `EXPORT_STORAGE_DIR`)
- `S3Storage` (production; writes to `EXPORT_S3_BUCKET` with
  server-side AES256 encryption; returns 15-minute presigned URLs)

`registerExportStorageFromEnv()` is called once at boot from
`src/index.ts` + the export worker. Driver selected by
`EXPORT_STORAGE_DRIVER` (`local` | `s3`).

The download route branches on backend: local backend pipes the file
stream to the response; S3 backend issues a 302 redirect to the
presigned URL. The `Export.file_path` schema column stores an opaque
locator (`/abs/path` or `s3://bucket/key`).

### GAP-103 / 104 / 105 — Business webhook sinks

A shared `business-webhook-ingest.ts` helper handles HMAC verify +
2-layer idempotency + WebhookEvent persist + outbox emit; per-business
modules supply only the routing config + Zod schema + drain handlers.

- **GAP-103 Aurean AI**: `POST /integration/aurean-ai/events` (HMAC
  with `AUREAN_AI_WEBHOOK_SECRET`), event-types `inference.completed`
  / `score.published` / `revenue.accrued` / `model.deployed`. Drain in
  `AureanAiProcessor`. KPI surface at `GET /aurean-ai/kpis`.
- **GAP-104 Aurean Recruitment**: `POST /integration/aurean-recruitment
/events`, event-types `candidate.entered_pipeline` /
  `candidate.stage_changed` / `placement.contracted` /
  `commission.earned` / `placement.rescinded`. Drain in
  `AureanRecruitmentProcessor`. KPI surface at
  `GET /aurean-recruitment/kpis` (30-day window).
- **GAP-105 HighSale business events**: `POST /integration/highsale
/events` (shares HMAC secret with the existing `/snapshots` route),
  event-types `inquiry.submitted` / `risk_band.assigned` /
  `snapshot.generated` / `revenue.recorded`. Drain in
  `HighSaleBusinessProcessor`. KPI surface at `GET /highsale/kpis`.

All three drains run inside `withTenantSession` so post-role-deploy
the eazepay_app role sees the GUC. The seed script now upserts the
7 launch-business orgs (`medpay` / `tradepay` / `coachpay` / `aurean-ai`
/ `aurean-recruitment` / `micamp-processing` / `highsale`) so KPI
endpoints have an org to resolve into out-of-the-box.

## 🟡 Deferred to future sessions

These are non-blockers — the platform is production-ready without them.

- **GAP-101** Lender adapter Plane 3 framework + reference adapter (~3–5 days; no code exists).
- **GAP-119** Customer detail lender data (depends on GAP-101).

## Production deploy checklist (Day-1 before merge)

The Phase 0 production assertions REFUSE BOOT without these. Set in Railway env BEFORE merging:

- `JWT_WS_TICKET_SECRET` — `openssl rand -base64 48`
- `JWT_INVESTOR_SCOPE_SECRET` — `openssl rand -base64 48`
- `CSRF_SIGNING_SECRET` — `openssl rand -base64 48`
- `OAUTH_STATE_SECRET` — `openssl rand -base64 48`
- `API_TOKEN_HASH_SECRET` — `openssl rand -base64 48`
- `AWS_KMS_KEY_ARN` — Sydney CMK ARN

After merge:

1. Run prisma migrate deploy (10 new migrations).
2. Run the eazepay_app role runbook ([`docs/runbooks/eazepay-app-role-deploy.md`](runbooks/eazepay-app-role-deploy.md)) during a maintenance window.
3. Switch `DATABASE_URL` to the new login user IN ROLE eazepay_app.
4. Start the new workers: `worker:pii-reencryption`, `worker:scheduled-report`, `worker:correlation-linker`.
5. Smoke test every read surface — RLS misconfigurations surface as empty result sets.

## Merge order

This is a single PR — merge `phase-1.5/callsite-retrofit-v2` → `main`. Everything is stacked on
top of Phase 1 + Phase 0 commits, so squash-merge brings in the whole stack atomically.
