# Security Hardening Plan — EazePay Intelligence

> Date: 2026-05-15
> Trigger: Pre-pen-test + enterprise-PII handover hardening pass.
> Author: Brodie + Claude (5 parallel review agents: security-auditor, architecture-critic, silent-failure-hunter, code-reviewer, type-design-analyzer).
> Status: **Findings consolidated. Fix phases below.**

---

## Executive summary

Five independent review agents and a dependency-CVE sweep surfaced **~106 distinct findings**. The codebase is already strong on _individual primitives_ — argon2id at OWASP cost, AES-256-GCM with random IV per message and version byte, refresh-token rotation with family revocation, 404-not-403 for cross-tenant org lookups, CSP/Helmet/rate-limit/CORS wired in the right order, KMS envelope encryption designed end-to-end.

It is **structurally weak on the multi-tenant boundary**. The single largest finding is that **~25 of 36 tenant-scoped tables do not carry an `orgId` column at all** (ARCH-100, SEC-101). The architecture docs claim every tenant table is row-scoped by `orgId`; in reality, `Application`, `LenderDecision`, `RevenueEvent`, `PixieMetric`, every Portfolio table, `Note`, `Tag`, `SavedView`, `ScheduledReport`, `Export`, `RtbfRequest`, `Alert`, `Case`, `OutboxEvent` — the data that actually matters — share a global namespace. The RLS infrastructure (`withTenantSession`, the staged policies) is well-designed but has **zero call sites** in production code. The per-org KMS-wrapped DEK system is similarly well-designed but `encryptForOrg()` is **never invoked from any domain write path** — every PII write still uses the global `PII_ENCRYPTION_KEY`. This means cryptoshred is non-functional and tenant A's data can be decrypted by tenant B's key.

The codebase is **safe today only because Brodie is the only ADMIN of every org and holds `PlatformRole.SUPER`** — the bugs are latent. They become exploits the moment a second tenant accepts an invitation.

A pen test would also fail on five surgical issues that are independent of the tenant boundary:

1. **Webhook HMAC computed over `JSON.stringify(req.body)` not raw bytes** (SEC-004 / CR-104 / SEC-100). Legitimate webhooks fail unpredictably; crafted payloads can pass.
2. **CSRF guard bypassable via path traversal** (CR-101) — `req.url.startsWith('/api/v1/webhooks/')` is checked against the raw URL before route resolution.
3. **JWT secrets shared across kinds** (CR-102) — access/ws_ticket/investor_scope tokens all signed with `JWT_ACCESS_SECRET`. Forge a `ws_ticket` payload using a legit access secret.
4. **SSRF in outbound webhooks** (SEC-110) — `fetch(sub.url, ...)` accepts any URL including AWS metadata, RFC1918, loopback.
5. **`LocalKmsClient` has no `NODE_ENV` guard** (SEC-108) — if `AWS_KMS_KEY_ARN` is unset in prod, PII silently encrypts under a deterministic HKDF derivation of `KMS_DEV_SECRET`.

Additionally, the **web tier (`apps/web/next.config.mjs`) has zero security headers** — no HSTS, no CSP, no Referrer-Policy, no Permissions-Policy. The web is what owns the auth cookies. A single React XSS drains HttpOnly cookies via a token-stealing redirect, with nothing to stop it.

Dependency CVEs: **33 vulnerabilities, 16 high**. Next.js 14 has multiple high-severity DoS + SSRF advisories patched in 15.5.16. Fastify 4 has a Content-Type tab body-validation bypass patched in 5.7.2. Both are major-version bumps.

This document is the punch list. Section "Phased plan" sequences the work; section "Finding catalog" is the de-duplicated complete list with origin (CR/ARCH/SF/SEC/TD codes from the five review agents).

---

## Severity definitions

| Tier                                                         | Meaning                                                                  | Examples                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **P0 — block pen test, block second-tenant onboarding**      | Cross-tenant data exposure, crypto bypass, RCE, SSRF to metadata         | SEC-100, SEC-101/CR-100/ARCH-100 (orgId), SEC-110, SEC-108, ARCH-101 (DEK never used), SEC-145 (RTBF incomplete)             |
| **P1 — block production hardening sign-off**                 | Auth subtle bugs, append-only enforcement, audit-log integrity, dep CVEs | CR-101, CR-102, CR-103, SEC-115, ARCH-105 (REVOKE), ARCH-106 (refresh-token scope), SEC-105 (public TCP proxies), Next 14→15 |
| **P2 — defense in depth, observable to a thorough pen test** | Header hardening, rate-limit edge cases, SSO depth                       | SEC-131 (web headers), SEC-113 (jti deny-list), SEC-121 (JWKS), SF-003 (rate-limit fail-closed)                              |
| **P3 — quality / type-level safety / lower-risk surfaces**   | Branded types, error-message hygiene, dev-only catches                   | TD-100..103, SEC-129, CR-108                                                                                                 |

---

## Phased plan

### Phase 0 — Surgical fixes (TODAY, no schema changes)

These are 1-line to 1-file changes that close real vulnerabilities without touching the multi-tenant schema. Shippable today.

- **F0.1** Webhook raw-body HMAC verification (SEC-004 / CR-104 / SEC-100): register `addContentTypeParser` capturing `req.rawBody: Buffer`; sign against the buffer, not a re-serialised body. Affects `apps/api/src/shared/middleware/webhook-signature.middleware.ts:101-103` + 2 integration routes.
- **F0.2** CSRF path-traversal bypass (CR-101): replace `req.url.startsWith('/api/v1/webhooks/')` with a route-config flag `routeOptions.config.skipCsrf === true`, set on the webhook routes only.
- **F0.3** JWT secrets per kind (CR-102 + SEC-115): add `JWT_WS_TICKET_SECRET`, `JWT_INVESTOR_SCOPE_SECRET`, `CSRF_SIGNING_SECRET`, `OAUTH_STATE_SECRET` to env; update `secretFor(kind)` to dispatch; update CSRF token issuer + OAuth state to use their own secrets.
- **F0.4** PAT secret pepper (CR-103): add `API_TOKEN_HASH_SECRET` env var; replace `createHash('sha256').update(secret)` with `createHmac('sha256', env.API_TOKEN_HASH_SECRET).update(secret)`. **Migration: re-hash existing tokens? No — they verify against the old hash. Add a `hashVersion` column and accept both during a 90-day window, then drop.**
- **F0.5** SSRF allowlist for outbound webhooks (SEC-110): in `outbound-webhook.service.ts`, before every `fetch`, resolve hostname → reject if private (`net.isIP` + RFC1918 + 169.254.x + 127.x + ::1 + fc00::/7); set `redirect: 'manual'`; cap response body size.
- **F0.6** LocalKmsClient prod guard (SEC-108): in constructor, `if (process.env.NODE_ENV === 'production') throw new Error('LocalKmsClient cannot be used in production')`. In `env.ts`, require `AWS_KMS_KEY_ARN` when `NODE_ENV === 'production'`.
- **F0.7** Cryptoshred refuses LocalKmsClient (SF-004): in `cryptoshredOrg`, assert `getKmsClient().isProductionGrade === true` (add the flag) before any DB mutation.
- **F0.8** trustProxy hop count (SEC-126): `trustProxy: 1` (single hop = Railway proxy) instead of `true`.
- **F0.9** x-request-id UUID validation (CR-108): regex-validate the header before accepting; fall through to uuidv7 if invalid.
- **F0.10** Idempotency-Key length/charset validation (SEC-133): regex `/^[A-Za-z0-9_-]{16,128}$/` in `verifyWebhookSignature` before Redis touch.
- **F0.11** Generic decrypt error message (SEC-129): throw `errors.internal('PII decryption failed')` externally; log envelope details internally only.
- **F0.12** Web-tier security headers (SEC-131): add `headers()` to `apps/web/next.config.mjs`: HSTS preload, CSP nonce-based, X-Content-Type-Options, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy deny camera/mic/geo/payment.
- **F0.13** API-tier Helmet hardening: explicit HSTS max-age 1y + preload, Cross-Origin-Opener-Policy same-origin, Cross-Origin-Resource-Policy same-site, stricter CSP than `useDefaults`.
- **F0.14** `__Host-` cookie prefix enforcement (SEC-122): cookie helper rejects `Domain=` when name has `__Host-`; always sets `Secure`.
- **F0.15** OAuth `verifyIdToken` via JWKS not tokeninfo (SEC-121): swap to local JWKS verification using cached Google certs. Pin algorithm to RS256.
- **F0.16** OAuth `claims.hd` check against allowed domains (SEC-125).
- **F0.17** Drop dead try/catch around `Buffer.from(hex)` (SF-018) — `Buffer.from(_, 'hex')` doesn't throw.
- **F0.18** Fix `scope ?? 'operator'` bug (TD-121): `'operator'` isn't an AuthScope value.
- **F0.19** Lower-risk silent-failure logs (SF-005, SF-007, SF-011, SF-012, SF-013, SF-015, SF-016, SF-017): replace `.catch(() => {})` with `.catch(err => log.warn(...))` in all listed spots.

**Estimated effort:** 4-6 hours. Ships as one PR. Should be reviewed before merge.

---

### Phase 1 — Tenant boundary (THIS WEEK, 2-3 days)

The most important work in the entire document. Until this lands, no second tenant can safely be invited.

- **F1.1** `add_org_id_to_tenant_tables.sql`: ALTER TABLE on every tenant-scoped table missing `org_id`. Affected models per ARCH-100 / SEC-101:
  - `Partner`, `Application`, `LenderDecision`, `RevenueEvent`, `PixieMetric`, `RevenueAggregation`
  - All 8 `Portfolio*` tables
  - `WebhookEvent`, `OutboxEvent`
  - `Note`, `Tag`, `TagAssignment`, `SavedView`, `ScheduledReport`, `ReportRun`
  - `Case`, `Alert`, `AlertRule`, `NotificationChannel`
  - `WebhookSubscription`, `WebhookDelivery`, `Export`
  - `RtbfRequest`

  Default backfill: bootstrap org UUID. Then `DROP DEFAULT` and `NOT NULL`.

- **F1.2** Add composite indexes `@@index([orgId, createdAt(sort: Desc)])` to every list-paginated tenant table.

- **F1.3** Per-org unique constraints:
  - `Partner`: drop `@unique` on `externalId`, add `@@unique([orgId, externalId])` (ARCH-103).
  - `RevenueEvent`: change unique to `@@unique([orgId, source, idempotencyKey])` (ARCH-104).
  - `WebhookEvent`: same `(orgId, source, idempotencyKey)` (ARCH-104).
  - `CreditEnrichment`: `@@unique([orgId, highsaleTransactionId])` (ARCH-113).
  - `Tag`: `@@unique([orgId, name])` (ARCH-116).

- **F1.4** `WebhookCredential` partial unique index (ARCH-111): `CREATE UNIQUE INDEX webhook_credentials_active_secret ON webhook_credentials(source, signing_secret_hash) WHERE is_active = true`.

- **F1.5** Route handler retrofit: every domain repository accepts `orgId: OrgId`, every Prisma `findMany/findUnique/findFirst/update/delete` adds `where: { orgId, ... }`. Affected files (per agent reports + my own grep):
  - `apps/api/src/domains/customers/customer.routes.ts` (4 endpoints, raw SQL + Prisma)
  - `apps/api/src/domains/applications/application.routes.ts` + repository
  - `apps/api/src/domains/revenue/revenue.routes.ts` + repository
  - `apps/api/src/domains/lenders/lender.routes.ts` + repository
  - `apps/api/src/domains/partners/partner.routes.ts`
  - `apps/api/src/domains/portfolio/portfolio.routes.ts` + repository
  - `apps/api/src/domains/exports/export.service.ts` (every `gatherRows` arm)
  - `apps/api/src/domains/admin/admin.routes.ts` (`/audit-logs`)
  - `apps/api/src/domains/notes/note.routes.ts`
  - `apps/api/src/domains/tags/tag.routes.ts`
  - `apps/api/src/domains/alerts/alert.routes.ts`
  - `apps/api/src/domains/scheduled-reports/scheduled-report.routes.ts`
  - `apps/api/src/domains/search/search.routes.ts` (push hash-prefix filter to PG too — SEC-124)
  - `apps/api/src/domains/rtbf/rtbf.routes.ts`
  - `apps/api/src/domains/outbound-webhooks/outbound-webhook.service.ts` (SEC-111 dispatch by orgId)
  - `apps/api/src/domains/pixie/pixie.routes.ts`
  - `apps/api/src/domains/analytics/analytics.routes.ts`

- **F1.6** Move tenant-scoped routes under `/o/:orgSlug/` prefix where they aren't already; chain `[requireAuth, resolveTenantFromPath]` instead of `requireAuth` alone. Estimated ~50-70 endpoint moves.

- **F1.7** Wire `withTenantSession` so every tenant-scoped request sets `app.org_id` GUC. Implementation: a Fastify preHandler that wraps the handler in `prisma.$transaction(tx => { await tx.$executeRawUnsafe(\`SET LOCAL app.org_id = '\${orgId}'\`); return handler(tx) })`. Repositories receive `tx`from`req.tx`, not module-scope `getPrisma()`.

- **F1.8** Extend RLS migration to the retrofitted tables — same `org_id = current_setting('app.org_id', TRUE) OR current_setting('app.platform_staff', TRUE) = 'true'` policy shape.

- **F1.9** Switch from `ENABLE ROW LEVEL SECURITY` to `FORCE ROW LEVEL SECURITY` on every covered table.

- **F1.10** Create `eazepay_app` Postgres role with `NOBYPASSRLS` and `REVOKE UPDATE, DELETE` on `audit_logs`, `revenue_events`, `webhook_events`, `outbox_events`, `credit_enrichments` (ARCH-105). Switch `DATABASE_URL` to this role in production. **Add startup assertion**: API refuses to boot if its DB user has `BYPASSRLS`.

- **F1.11** `writeAuditLog` accepts `tx?: Prisma.TransactionClient` (SF-009), requires `orgId` for tenant-scoped actions, allows NULL only for an enumerated set of platform-level actions (ARCH-107).

- **F1.12** `bearer-auth` enforces `ApiToken.scopes` (READ/WRITE/ADMIN) per route via a new `requireApiTokenScope('WRITE')` preHandler (ARCH-112).

- **F1.13** Platform-staff cross-tenant audit: `withTenantSession({ platformStaff: true, reason: 'rotation' | ... })` auto-writes `PLATFORM_CROSS_TENANT_ACCESS` audit row (ARCH-108). `resolveTenantFromPath` tags audit metadata with `actorPlatformRole` when the user has one (ARCH-109).

- **F1.14** Membership re-check on cookie auth too (SEC-114 + ARCH-120): `requireAuth` validates the JWT's `payload.org` membership still exists; if not, revoke session.

- **F1.15** Membership `revokedAt` soft-delete (ARCH-122) — preserve forensic history.

- **F1.16** STAFF per-org access grant table (CR-105): `platform_staff_access(staff_user_id, org_id, granted_by, granted_at, expires_at, reason)`. `resolveTenantFromPath` requires a row to exist before synthesising ADMIN.

**Estimated effort:** 2-3 days of focused work. Should ship as a stack of PRs:

- PR A: schema retrofit (F1.1 - F1.4)
- PR B: route handler scoping (F1.5)
- PR C: RLS rollout + role-level REVOKE (F1.7 - F1.10)
- PR D: audit/auth tightening (F1.11 - F1.16)

---

### Phase 2 — Per-org DEK threading + RTBF completeness (2-3 days)

The encryption layer is half-built. `encryptForOrg()` exists, `cryptoshredOrg` exists, but the write paths still call the global-key `encryptPII()`. Until this lands, the per-tenant key promise is fiction.

- **F2.1** Add `orgId` resolution to the webhook ingestion path. `WebhookCredential` maps `(source, signing_secret_hash) → orgId`; the signature verifier puts the resolved `orgId` into the queued job payload.

- **F2.2** Replace every domain-code `encryptPII(x)` with `await encryptForOrg(prisma, x, orgId)`:
  - `apps/api/src/domains/integration/highsale/highsale.routes.ts:149-153`
  - `apps/api/src/domains/webhooks/webhook.service.ts` (every PII write)
  - `apps/api/src/domains/applications/*` (the toApplicationResponse path)
  - `apps/api/src/domains/integration/eazepay-app/*` (incoming application events)

- **F2.3** Replace every domain-code `decryptPII(buf)` with `decryptEnvelopeAuto(prisma, buf, decryptPII)` (the dispatcher already exists in `tenant-dek.ts`).

- **F2.4** Background worker `re-encrypt-v1-to-v2.worker.ts`: scan PII columns where version byte == 0x01, re-encrypt under the row's org DEK, mark v2 (0x02).

- **F2.5** RTBF completeness (SEC-145 + ARCH-115): `RtbfService.processInner` must also scrub `webhook_events.payload` rows that match the consumer's email hash. Better: store webhook payload encrypted under per-org DEK at receive time, so cryptoshred kills it.

- **F2.6** `encryptPII` global-key feature flag (ARCH-101): gate behind `ALLOW_LEGACY_GLOBAL_PII_KEY` env var, throw if called when flag is off. Default off in production after F2.4 completes.

- **F2.7** AAD for ciphertext binding (ARCH note): include `${tableName}:${columnName}:${rowPk}` as AAD when calling `setAAD` on the GCM cipher. Prevents confused-deputy ciphertext transplant.

- **F2.8** Encryption-cache eviction on cryptoshred (ARCH-114): expose `evict(orgId)` API on the cache so cryptoshredded DEKs aren't held in memory.

**Estimated effort:** 2-3 days. PR E.

---

### Phase 3 — Auth subsystem hardening (1-2 days)

- **F3.1** Refresh-token scope/orgId/sessionId binding (ARCH-106 + CR-105 + SEC-114):
  - Add `scope`, `orgId`, `sessionId` columns to `RefreshToken`.
  - On `toggleScope`, revoke the old family.
  - On `refresh`, re-validate Membership in `orgId`; revoke family + 401 if gone.
  - Add per-device session revocation via `sessionId`.

- **F3.2** MFA rate limiter per-user (CR-106 + SEC-130): `mfa:fail:${userId}` Redis bucket max 5 per 90s; lock account on 10 fails / hour.

- **F3.3** Access-token deny-list on logout (SEC-113): `denyJti:${jti}` Redis key with TTL = access remaining. Check in `requireAuth`.

- **F3.4** OAuth PKCE (SEC-106): S256 `code_verifier` random 32 bytes, stored in HttpOnly cookie alongside state. Verify both on callback.

- **F3.5** OAuth state bound to session (SEC-106): include `sub` hash in state cookie if user is mid-link-account flow.

- **F3.6** OAuth callback redirect allowlist (SEC-134): wrap `reply.redirect(...)` in `safeRedirect(dest)` that asserts dest is in a fixed allowlist.

- **F3.7** MFA setup secret IP/UA binding (SEC-130).

- **F3.8** Customer PII reveal: read from writer not replica (SEC-120) — RTBF freshness.

- **F3.9** Customer PII reveal: audit BEFORE decrypt (SF-010) — surface specific error codes for `PII_DECRYPT_FAILED` vs `AUDIT_INSERT_FAILED`.

- **F3.10** Outbound webhook signing: store secret encrypted at rest (SEC-112), sign with plaintext so subscribers can verify.

**Estimated effort:** 1-2 days. PR F.

---

### Phase 4 — Infra + dep upgrades (1 day)

- **F4.1** Move Postgres + Redis from public TCP proxies to Railway private networking (SEC-105). Rotate every production secret + re-encrypt PII corpus.
- **F4.2** Next.js 14 → 15.5.16+ upgrade. App-Router compatibility check, smoke-test middleware + RSC paths.
- **F4.3** Fastify 4 → 5.7.2+ upgrade. Verify route registration shape, schema/Ajv changes.
- **F4.4** `@opentelemetry/sdk-node` 0.54 → 0.217+ + autocompile peer deps.
- **F4.5** `glob` 10.3 → 10.5+ (transitive via `eslint-config-next`, dev-only).

**Estimated effort:** 1 day for Next + Fastify majors (most of it is test + smoke). PR G.

---

### Phase 5 — Defense in depth + observability (1 day)

- **F5.1** Rate-limit pipe-level fail-closed (SF-003): in `rate-limit.middleware.ts`, `throw errors.serviceUnavailable` on any Redis-level error in MULTI exec. Today it silently skips. Server.ts already says `skipOnError: false` but the lower-level pipe handles errors permissively.
- **F5.2** Outbox worker max-attempts + DLQ (SF-006).
- **F5.3** WebhookEvent + Outbox row creation transactional in same tx (SEC-116).
- **F5.4** Distinguish HMAC-verified vs PAT-pushed events (SEC-117): `WebhookEvent.ingestionSource` enum.
- **F5.5** Export `filePath` validation against allowed base dir (SEC-119). Better: switch to S3 signed URLs.
- **F5.6** OAuth + email + outbound fetch all wrapped with `AbortSignal.timeout(10_000)` (SF-011).
- **F5.7** WebSocket gateway logs malformed pub/sub (SF-012). Add `ws_malformed_payload` counter.
- **F5.8** `Note.resourceId` UUID validation per `resourceType` (SEC-142).
- **F5.9** Logger redact path test: integration test that floods PII through every endpoint and asserts pino output never contains plaintext PII (SEC-128).

**Estimated effort:** 1 day. PR H.

---

### Phase 6 — Type-system hardening (ongoing, can be incremental)

- **F6.1** Brand `OrgId` (TD-100). Narrow at three middleware sites: `requireAuth`, `resolveTenantFromPath`, `requireBearerAuth`. Thread through `tenantKey`, `withTenantSession`, every repository.
- **F6.2** Brand `PiiPlaintext` / `PiiCiphertext` (TD-101). Force `mask(p)` or `reveal(p, audit)` at the type boundary.
- **F6.3** Discriminated `AuthContext` union (TD-102). Routes that read `req.auth.orgId` only compile under a tenant-scoped variant.
- **F6.4** Brand `TenantPrisma` (TD-110). Repositories accept only the RLS-pinned client.
- **F6.5** Brand `AccessJwt`, `RefreshToken`, `Pat`, `WsTicket`, `CsrfToken` (TD-103).
- **F6.6** Per-source `eventType` literal unions (TD-111).
- **F6.7** Discriminated `JwtPayload` union by `kind` (TD-112).

**Estimated effort:** 2-3 days incremental; can ship behind a long-lived branch and merge in chunks.

---

## Finding catalog (de-duplicated)

### Cross-tenant data exposure (P0)

| ID   | Source                    | Title                                                                      | File:line                         |
| ---- | ------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| X-01 | CR-100 / SEC-102 / SF-001 | `/customers/:hash/pii` reveals decrypted PII without orgId filter          | `customer.routes.ts:256`          |
| X-02 | CR-107 / SEC-102          | `/customers` list + `/customers/:hash` detail unscoped                     | `customer.routes.ts:53,156`       |
| X-03 | ARCH-100 / SEC-101        | ~25 tenant tables missing `orgId` column entirely                          | `schema.prisma`                   |
| X-04 | SF-002 / SEC-118          | `/exports/*` returns cross-tenant data (audit logs especially)             | `export.service.ts:96-227`        |
| X-05 | SEC-146                   | `/admin/audit-logs` no orgId filter                                        | `admin.routes.ts:96`              |
| X-06 | SEC-109                   | Notes / tags / saved-views / alerts cross-tenant readable                  | `notes/tags/search/alerts` routes |
| X-07 | SEC-124                   | Search hash-prefix enumeration platform-wide                               | `search.routes.ts:104`            |
| X-08 | SEC-111                   | Outbound webhook dispatch fans events to every tenant's subscribers        | `outbound-webhook.service.ts:28`  |
| X-09 | ARCH-103                  | `Partner.externalId` globally unique → wrong-tenant webhook routing        | `schema.prisma:123`               |
| X-10 | ARCH-104                  | `(source, idempotencyKey)` globally unique → cross-tenant DoS / steal      | `schema.prisma:257,281`           |
| X-11 | ARCH-113                  | `CreditEnrichment.highsaleTransactionId` globally unique                   | `schema.prisma:1233`              |
| X-12 | ARCH-115 / SEC-145        | `WebhookEvent.payload` stores raw PII unencrypted, no orgId                | `schema.prisma`                   |
| X-13 | ARCH-117                  | `NotificationChannel` no orgId/owner — alert rules cross-target            | `schema.prisma:690`               |
| X-14 | ARCH-116                  | `Tag.name` globally unique → squatting                                     | `schema.prisma:1008`              |
| X-15 | ARCH-110                  | `Note`/`SavedView`/`ScheduledReport`/`Case`/`Export` userId-only, no orgId | `schema.prisma:989-1117`          |

### Crypto / auth bypass (P0/P1)

| ID   | Source                     | Title                                                                     | File:line                                        |
| ---- | -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| C-01 | SEC-004 / CR-104 / SEC-100 | Webhook HMAC over re-stringified body, not raw bytes                      | `webhook-signature.middleware.ts:101`            |
| C-02 | CR-101 / SEC-107           | CSRF guard URL-prefix bypass via path-traversal                           | `csrf.middleware.ts:14`                          |
| C-03 | CR-102                     | JWT secrets shared across access/ws_ticket/investor_scope                 | `jwt.ts:53`                                      |
| C-04 | SEC-115                    | `JWT_ACCESS_SECRET` reused for CSRF + OAuth state                         | `auth.service.ts:216,234`, `oauth.routes.ts:209` |
| C-05 | CR-103                     | API token secret stored as bare SHA-256 (no HMAC pepper)                  | `api-token.ts:27,39`                             |
| C-06 | SEC-108                    | LocalKmsClient has no NODE_ENV guard                                      | `local-kms-client.ts`                            |
| C-07 | SF-004                     | `cryptoshredOrg` runs against LocalKmsClient without asserting prod-grade | `tenant-dek.ts:303`                              |
| C-08 | ARCH-101                   | `encryptForOrg()` never called — every PII write uses global key          | every domain                                     |
| C-09 | ARCH-105                   | No `REVOKE`/`GRANT` for `eazepay_app` role — append-only unbacked         | migrations/\*                                    |
| C-10 | ARCH-102                   | `withTenantSession` exists, called nowhere — RLS theatre                  | `tenant-context.ts:100`                          |
| C-11 | SEC-105                    | Postgres + Redis on public TCP proxies in prod                            | infra                                            |
| C-12 | SEC-106                    | OAuth state HMAC but no PKCE, not session-bound                           | `oauth.routes.ts:207`                            |
| C-13 | SEC-121                    | OAuth verifyIdToken uses Google `tokeninfo` not JWKS                      | `oauth.routes.ts:233`                            |
| C-14 | SEC-104                    | JWT secrets only enforce min(32) chars, no entropy check                  | `env.ts:26-27`                                   |

### SSRF / arbitrary read (P0/P1)

| ID   | Source  | Title                                                                   | File:line                         |
| ---- | ------- | ----------------------------------------------------------------------- | --------------------------------- |
| S-01 | SEC-110 | Outbound webhook URL allows AWS metadata, RFC1918, loopback             | `outbound-webhook.service.ts:119` |
| S-02 | SEC-119 | `/exports/:id/download` no path validation on `row.filePath`            | `export.routes.ts:106`            |
| S-03 | SEC-112 | Outbound webhook signs with `secretHash` not secret — useless integrity | `outbound-webhook.service.ts:117` |

### Auth subtle bugs (P1)

| ID   | Source             | Title                                                                           | File:line                                 |
| ---- | ------------------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| A-01 | CR-105             | STAFF synthesises ADMIN in every org with no per-org grant                      | `auth.middleware.ts:101`                  |
| A-02 | CR-106 / SEC-130   | MFA shares login rate-limit bucket → brute-forceable                            | `auth.service.ts:41`                      |
| A-03 | ARCH-106           | RefreshToken has no `scope`/`orgId`/`sessionId` — survives membership revoke    | `schema.prisma:478`, `auth.service.ts:52` |
| A-04 | SEC-113            | Access JWT `jti` not deny-list-tracked — logout doesn't kill access cookie      | `jwt.ts:93`                               |
| A-05 | SEC-114 / ARCH-120 | `requireAuth` trusts JWT `org`/`orgRole` without DB re-check                    | `auth.middleware.ts:40`                   |
| A-06 | SEC-126            | `trustProxy: true` allows X-Forwarded-For spoofing                              | `server.ts:75`                            |
| A-07 | SEC-125            | OAuth doesn't check `claims.hd` against allowed domains                         | `oauth.routes.ts:153`                     |
| A-08 | ARCH-107           | Audit log INSERT policy allows NULL orgId rows that nobody sees                 | migration `20260508220000:121`            |
| A-09 | ARCH-112           | `ApiToken.scopes` (READ/WRITE/ADMIN) not enforced anywhere                      | `bearer-auth.middleware.ts:64`            |
| A-10 | ARCH-111           | `WebhookCredential` no partial unique index on `(source, hash) WHERE is_active` | migration / schema                        |

### Web tier / headers (P2)

| ID   | Source       | Title                                                        | File:line         |
| ---- | ------------ | ------------------------------------------------------------ | ----------------- |
| W-01 | SEC-131      | `apps/web/next.config.mjs` has zero security headers         | `next.config.mjs` |
| W-02 | (this audit) | API Helmet config minimal: only `frame-ancestors:'none'` set | `server.ts:86`    |
| W-03 | SEC-122      | `__Host-` cookie prefix rules not enforced by cookie helper  | `cookies.ts:24`   |

### Silent failure / fail-open (P2)

| ID   | Source  | Title                                                               | File:line                             |
| ---- | ------- | ------------------------------------------------------------------- | ------------------------------------- |
| F-01 | SF-003  | Rate limiter MULTI exec failures silently skip enforcement          | `rate-limit.middleware.ts:24`         |
| F-02 | SF-005  | `verifyPassword` swallows all errors → "wrong password"             | `password.ts:15`                      |
| F-03 | SF-006  | Outbox worker no max-attempts, no DLQ                               | `outbox.worker.ts:74`                 |
| F-04 | SF-009  | `writeAuditLog` doesn't accept `tx` → audits outside mutation tx    | `audit-log.middleware.ts:36`          |
| F-05 | SF-010  | PII reveal: audit happens AFTER decrypt                             | `customer.routes.ts:268`              |
| F-06 | SF-011  | OAuth fetches have no timeout                                       | `oauth.routes.ts:141`                 |
| F-07 | SF-012  | WebSocket malformed pub/sub silently dropped                        | `analytics.gateway.ts:81`             |
| F-08 | SF-013  | `consumeWsTicket` silently returns null on invalid ticket           | `auth.service.ts:138`                 |
| F-09 | SF-014  | `portfolio.repository.update` `.catch(() => null)` masks all errors | `portfolio.repository.ts:210`         |
| F-10 | SF-015  | webhook-delivery worker swallows ABANDONED status update            | `webhook-delivery.worker.ts:40`       |
| F-11 | SF-016  | server.ts rate-limit denial counter `.catch(()=>{})`                | `server.ts:143`                       |
| F-12 | SF-017  | BUZZPAY arm silently drops replays                                  | `webhook.service.ts:36`               |
| F-13 | SEC-116 | WebhookEvent + outbox split across preHandler/handler — not atomic  | `webhook-signature.middleware.ts:141` |
| F-14 | SEC-117 | Ingestion route hard-codes `signatureValid: true` → provenance loss | `ingestion.routes.ts:277`             |

### Type system holes (P3)

| ID   | Source | Title                                                                    |
| ---- | ------ | ------------------------------------------------------------------------ |
| T-01 | TD-100 | `OrgId` not branded                                                      |
| T-02 | TD-101 | Decrypted PII shares `string` type — no mask/reveal force                |
| T-03 | TD-102 | `AuthContext` is one shape with optional `orgId` — not discriminated     |
| T-04 | TD-103 | All token kinds are `string`                                             |
| T-05 | TD-110 | Repos accept `PrismaClient`, not `TenantPrisma` brand                    |
| T-06 | TD-111 | `eventType` is free-form string — no per-source literal union            |
| T-07 | TD-112 | `JwtPayload` single shape — not discriminated by `kind`                  |
| T-08 | TD-121 | `req.auth.scope ?? 'operator'` — `'operator'` isn't an `AuthScope` value |

### Nits / cleanup (P3)

| ID   | Source  | Title                                                                                              |
| ---- | ------- | -------------------------------------------------------------------------------------------------- |
| N-01 | CR-108  | `x-request-id` from client unsanitised                                                             |
| N-02 | SEC-129 | Decrypt error messages expose envelope structure                                                   |
| N-03 | SEC-133 | Idempotency-Key not length/charset-validated before Redis SETNX                                    |
| N-04 | SEC-134 | OAuth redirects to `${APP_URL}` without allowlist                                                  |
| N-05 | SEC-135 | `partnerId` interpolated into Prisma.sql without org-membership check                              |
| N-06 | SEC-138 | `BUZZPAY_WEBHOOK_SECRET` still in `.env` after Phase B retirement                                  |
| N-07 | SEC-140 | Prisma.Decimal duck-type check is fragile                                                          |
| N-08 | SEC-141 | Worker concurrency uncapped per-tenant                                                             |
| N-09 | SEC-142 | `Note.resourceId` accepts any string — no UUID validation                                          |
| N-10 | SF-018  | Dead `try/catch` around `Buffer.from(hex)`                                                         |
| N-11 | SF-019  | Outbound webhook HMAC keyed on hash, not secret                                                    |
| N-12 | SF-020  | OAuth log detail missing `errorId` for Sentry                                                      |
| N-13 | TD-122  | `UserRole` and `OrgRole` structurally identical but not interchangeable — tighten scope.middleware |
| N-14 | TD-123  | `WebhookSource.BUZZPAY` still in Prisma enum — Phase C migration owed                              |

### Dependency CVEs

| Package                                     | Current | Patched | Severity  | Advisory                                                                           |
| ------------------------------------------- | ------- | ------- | --------- | ---------------------------------------------------------------------------------- |
| `next`                                      | 14.2.35 | 15.5.16 | high (×4) | GHSA-h25m-26qc-wcjf, GHSA-q4gf-8mx6-v5v3, GHSA-8h8q-6873-q5fj, GHSA-c4j6-fc7j-m34r |
| `fastify`                                   | 4.29.1  | 5.7.2   | high      | GHSA-jx2c-rxcm-jvmq                                                                |
| `fast-uri`                                  | 3.1.0   | 3.1.2   | high (×2) | GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc                                           |
| `@opentelemetry/sdk-node`                   | 0.54.2  | 0.217.0 | high      | GHSA-q7rr-3cgh-j5r3                                                                |
| `@opentelemetry/auto-instrumentations-node` | 0.51.0  | 0.75.0  | high      | GHSA-q7rr-3cgh-j5r3                                                                |
| `glob` (dev, via eslint-config-next)        | 10.3.10 | 10.5.0  | high      | GHSA-5j98-mcp5-4vw2                                                                |
| `undici` (dev, via testcontainers)          | 5.29.0  | 6.24.0  | high (×2) | GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8                                           |

**Total**: 33 vulns (16 high, 14 moderate, 3 low).

---

## What's solid (leave it alone)

- Argon2id at OWASP-recommended cost (memory, time, parallelism). `password.ts`.
- AES-256-GCM envelope: random IV per message, version byte for rotation, auth-tag handling. `encryption.ts`. (Gaps: no AAD, no per-org key on write path — fixed in F2.)
- Refresh-token rotation with reuse-detect → family revocation. `auth.service.ts:52-84`, `auth.repository.ts`.
- HMAC-keyed refresh-token storage. `auth.repository.ts:29`.
- JWT signature verify is timing-safe with length check. `jwt.ts:75`.
- CSRF token signature compare is timing-safe with length check. `auth.service.ts:233`.
- Webhook two-layer idempotency (Redis SETNX hot + Postgres unique cold). Right architecture.
- 404-not-403 on cross-tenant org lookups. `auth.middleware.ts:92`.
- `denyInvestorScope` middleware as positive belt-and-braces gate.
- Per-tenant DEK envelope v2 design (per-org keyId in header, KMS lazy unwrap, cryptoshred). Gap is write-path adoption (F2).
- "Surgical escape" GUCs (`withInvitationLookup`, `withBearerLookup`) — each gates a single read narrowly.
- Plugin order: helmet → cors → sensible → rate-limit → websocket → auth → routes. Correct.
- Decimal-safe reply serializer. `server.ts:163-180`.
- Body limit per-route configurable, default 1MB.

---

## Next steps

I'm working through the punch list now. The first PR (Phase 0 — surgical fixes) lands the highest-impact items that don't touch the schema. Then Phase 1 (the tenant boundary) is the multi-day stack that has to land before any non-Brodie user joins. Phases 2-6 follow.

Status updates land in the per-PR descriptions. Re-running review agents after each phase to confirm closure.
