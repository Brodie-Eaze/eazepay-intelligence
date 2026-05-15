# Phase progress — security hardening + multi-tenant retrofit

> Authoritative tracker for the work captured in `HARDENING.md` (106 findings
> from 5 review agents) and `ENDPOINT_AUDIT.md` (20 endpoint gaps).
> Last updated: 2026-05-15.

Six PR-ready branches on origin. Production (`main`, commit `d8555ec`) is **untouched** — none of the work below has been merged yet.

## ✅ Done (PR-ready)

### Phase 0 — Surgical security fixes

- **Branch:** `chore/security-hardening-phase-0` · commit `392687b`
- **PR:** https://github.com/Brodie-Eaze/eazepay-intelligence/pull/new/chore/security-hardening-phase-0
- **Closes:** 19 findings (CR-101, CR-102, CR-103, CR-104/SEC-004, CR-108, SF-004, SF-005, SF-012, SF-017, SF-018, SEC-104, SEC-108, SEC-110, SEC-115, SEC-122, SEC-126, SEC-129, SEC-131, SEC-133, TD-121)
- Raw-body HMAC, CSRF path-traversal fix, JWT secrets per kind, PAT pepper, LocalKMS prod guard, SSRF allowlist, web tier security headers, env entropy assertions, `__Host-` cookies, x-request-id validation, idempotency-key regex, generic decrypt errors.

### Phase 1 — Schema retrofit (orgId)

- **Branch:** `feat/phase-1-multitenant-retrofit` · commit `5a2ff13`
- **What's done:** orgId added to ~20 tenant tables in 2 migrations, new enum values (EAZEPAY_APP / HIGHSALE / AUREAN_AI / AUREAN_RECRUITMENT / OFFERED / CONTRACTED / QUARANTINE), per-org unique constraints, partial call-site retrofit (tag.routes, webhook.service, webhook-signature.middleware, outbox.ts, aggregation.worker, alert.worker, application.repository), `shared/tenant/bootstrap-org.ts` helper. Plus HARDENING.md + ENDPOINT_AUDIT.md saved.
- **Status:** typecheck red on this branch alone — the call-site retrofit is on the Phase 1.5 branch which is its child.

### Phase 1.5 — Call-site orgId retrofit

- **Branch:** `phase-1.5/callsite-retrofit-v2` · commits `5c09ed6` → `d4f25d4` → `7229b19` → `9e58660`
- **PR:** https://github.com/Brodie-Eaze/eazepay-intelligence/pull/new/phase-1.5/callsite-retrofit-v2
- **Stacked on Phase 1.** Includes everything in Phase 1 plus:
  - `5c09ed6` — Phase 1.5 mechanical retrofit. orgId threaded through every Prisma create/upsert/findUnique across ~20 files: prisma/seed, application.repository/types/schemas, auth.repository (RefreshToken org-scoped), auth.service (preserves orgId across rotation), export.routes, notes.routes, outbound-webhook.{routes,service} (**dispatch now org-scoped — closes GAP-115**), partner.{service,repository,routes} (per-org externalId namespace), portfolio.repository (8 methods), scheduled-report.routes, search.routes, alerts.routes, rtbf.{service,routes}, ingestion.routes (org-scoped WebhookEvent + idempotency-key rename), ws-publisher (publishWsEvent first arg is now orgId), webhook.service (revenue events from partner.orgId).
  - `d4f25d4` — GAP-107 + GAP-111. Protected-class read gate on HighSale demographics block (FCRA — was returned to every authenticated user). RTBF credit_enrichments scrub (GDPR Art. 17 / APP 11 — was leaving HighSale PII echo untouched, scrubbed only the application).
  - `7229b19` — Phase 3 per-org DEK threading on HighSale write+read paths. encryptPII → encryptForOrg under the per-org DEK. decryptEnvelopeAuto routes v1 → legacy global key, v2 → per-org. Cryptoshred now actually destroys tenant data.
  - `9e58660` — Phase 4a + Phase 7 partial. JWT jti deny-list (logout-revokes-access-token, closes SEC-113 stolen-token-survives-logout window). Webhook-delivery abandon-marker now logs instead of swallowing (SF-015).
- **Verification:** typecheck green, 126/132 tests pass (6 pre-existing skips), web build clean.

### Phase 6 — Patch dep upgrades

- **Branch:** `phase-6/dep-patches` · commit `4f33f56`
- **PR:** https://github.com/Brodie-Eaze/eazepay-intelligence/pull/new/phase-6/dep-patches
- **Audit drop:** 33 → 20 vulnerabilities (13 high-severity CVEs closed)
- @opentelemetry/sdk-node 0.54→0.218 (resolves GHSA-q7rr-3cgh-j5r3 Prometheus exporter DoS), fastify 4.28→4.29 (latest 4.x), next 14.2.13→14.2.35 (latest 14.x within major), pnpm.overrides fast-uri≥3.1.2 / glob≥10.5.0 / undici≥6.24.0.
- Remaining 20 CVEs are all blocked behind next-major bumps (Next 14→15, Fastify 4→5, vite/esbuild via vitest) — deferred to a dedicated session.

### Rate-limit + MFA hardening

- **Branch:** `security/rate-limit-mfa-hardening` · commit `bf0bbe7`
- **PR:** https://github.com/Brodie-Eaze/eazepay-intelligence/pull/new/security/rate-limit-mfa-hardening
- **SF-003 fail-closed:** compositeRateLimit throws `errors.serviceUnavailable()` on every Redis-level failure mode (pipe throw / MULTI rollback / missing command result / per-command err). Previously each silently let requests through unthrottled.
- **CR-106 + SEC-130:** dedicated per-user MFA bucket on /auth/mfa/verify and /auth/mfa/disable (5 attempts per 90s per user). Failed verifications write a `USER_MFA_FAILED` audit row.
- **Secret-audit confirmation:** no .env files ever committed, no hardcoded secrets in source, only documented dev demo creds with rotation warnings.
- Partial SECURITY.md refresh (recovered from killed Phase 8 agent's in-flight work).

## 🟡 Queued — major work for future sessions

### Phase 1.6 — RLS rollout + eazepay_app role REVOKE

- Extend `ENABLE ROW LEVEL SECURITY` policies to the 20+ tables retrofitted in Phase 1 with `(orgId = current_setting('app.org_id', TRUE) OR current_setting('app.platform_staff', TRUE) = 'true')`.
- Switch from `ENABLE` to `FORCE ROW LEVEL SECURITY` once route handlers are reliably setting the GUC via `withTenantSession`.
- Create `eazepay_app` Postgres role with `NOBYPASSRLS` + `REVOKE UPDATE, DELETE ON audit_logs, revenue_events, webhook_events, outbox_events, credit_enrichments` to make the long-claimed "append-only at role level" real. Effort: ~4 hrs. Migration mostly written; needs deploy-time approval.

### Phase 4b — OAuth JWKS verification (replace tokeninfo)

- `oauth.routes.ts` currently verifies Google id_tokens via the deprecated `tokeninfo` endpoint (SEC-121). Replace with local JWKS verification against `https://www.googleapis.com/oauth2/v3/certs` (cached). Use `google-auth-library` or `jose`. ~1 day.

### Phase 4c — Refresh-token sessionId binding + OAuth PKCE

- Add `sessionId` to RefreshToken so a stolen refresh from one device can be revoked without nuking the whole family. Add PKCE (S256 code_verifier) to OAuth flow (SEC-106). ~1 day.

### GAP-100 — EazePay App sink full implementation

- **CRITICAL: currently silently dropping medpay/tradepay/coachpay traffic.** The route is registered but returns `persisted: false`. Schema groundwork is in Phase 1 (EAZEPAY_APP enum value), but the handler still doesn't persist.
- Build: WebhookEvent persistence, outbox row, drain handlers for the 6 contracted event types (application.offers_presented / contracted / declined, merchant.onboarded / status_changed, commission.recorded). ~1-2 days.

### Phase 3 (continued) — per-org DEK on remaining PII write paths

- Application table PII (consumerNameCiphertext/Email/Phone) — still uses v1 global key on writes. Read path already dispatches via decryptEnvelopeAuto. Phase 3 done for HighSale credit_enrichments only. Migrate Application writes after GAP-100 lands (the new EazePay App drain handlers will be the primary writer).
- v1→v2 background re-encryption worker for existing rows. ~1 day.

### Phase 7 (continued) — silent-failure cleanup

- writeAuditLog accepts tx client (SF-009) so audit + mutation roll back together.
- Outbox worker max-attempts + DLQ (SF-006) — poison-pill rows currently re-claimed forever.
- OAuth fetch timeouts (SF-011) — Google outage currently dangles the connection pool. ~4 hrs.

### GAP-103 / GAP-104 / GAP-105 — Aurean AI / Recruitment / HighSale typed event schemas

- Enum values landed in Phase 1 migration. Need Zod schemas, drain handlers, per-business KPI read endpoints. ~1 day each.

### Other queued endpoint gaps from ENDPOINT_AUDIT.md

- GAP-101 Lender adapter Plane 3 (large — no code exists, ~3-5 days)
- GAP-106 Application correlation linker (credit_enrichments.applicationId always null)
- GAP-108 Per-org analytics endpoints (currently platform-wide global)
- GAP-109 S3 export delivery (currently local disk, lost on Railway redeploy)
- GAP-110 Scheduled report worker (CRUD exists but nothing executes runs)
- GAP-112 /platform/reconciliation
- GAP-113 Audit log org filter + AUDIT_LOG export type
- GAP-117 HighSale snapshot async export

## Production deploy checklist (Day-1 must-do before merging Phase 0)

The Phase 0 production assertions REFUSE BOOT without:

- `JWT_WS_TICKET_SECRET` — `openssl rand -base64 48`
- `JWT_INVESTOR_SCOPE_SECRET` — `openssl rand -base64 48`
- `CSRF_SIGNING_SECRET` — `openssl rand -base64 48`
- `OAUTH_STATE_SECRET` — `openssl rand -base64 48`
- `API_TOKEN_HASH_SECRET` — `openssl rand -base64 48`
- `AWS_KMS_KEY_ARN` set to the Sydney CMK ARN

Set these in Railway env vars before merging `chore/security-hardening-phase-0` to main.

## Merge order recommendation

1. `chore/security-hardening-phase-0` — safest, all-surgical fixes
2. `phase-6/dep-patches` — independent of app code; closes 13 CVEs
3. `security/rate-limit-mfa-hardening` — surgical rate-limit + MFA
4. `feat/phase-1-multitenant-retrofit` + `phase-1.5/callsite-retrofit-v2` — together. Phase 1.5 is a child branch; merge it (it carries Phase 1 + the call-site work + GAP-107 + GAP-111 + Phase 3 + Phase 4a). After this lands the schema migration runs on deploy.

After all four merge: production has the surgical security fixes, the dep CVE patches, the rate-limit + MFA hardening, and the multi-tenant orgId infrastructure end-to-end. PII handling is enterprise-grade for the HighSale plane.

The queued items above are the work remaining to reach "every endpoint built + every CVE closed + every audit finding resolved." Each represents 4 hours to 5 days of focused work.
