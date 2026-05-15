# Security · EazePay Intelligence

This document is the technical security narrative — the **posture** as it stands today after the Phase 0 hardening pass. For the auditor-facing control mapping see [`docs/governance/SOC2_CONTROLS.md`](docs/governance/SOC2_CONTROLS.md). For data classification and PII handling see [`docs/governance/PRIVACY.md`](docs/governance/PRIVACY.md) + [`docs/governance/DATA_CLASSIFICATION.md`](docs/governance/DATA_CLASSIFICATION.md).

Companion documents:

- [`docs/reviews/HARDENING.md`](docs/reviews/HARDENING.md) — 106-finding catalogue from the five-agent pre-pen-test review + phased remediation plan. Authoritative punch list.
- [`docs/reviews/ENDPOINT_AUDIT.md`](docs/reviews/ENDPOINT_AUDIT.md) — 20-gap endpoint inventory and warehouse-completeness audit.
- [`docs/PHASE_PROGRESS.md`](docs/PHASE_PROGRESS.md) — what's shipped, what's queued, branch/commit pointers per phase.

This file describes the **current security posture**. It is not a changelog and not a plan; for either of those, see the docs above.

---

## Threat model (STRIDE — refreshed for the post-Phase-0 posture)

The model below lists the top threats and the mitigation in production today. Items marked **(closed in Phase 0)** are vulnerabilities that existed in the pre-hardening codebase and are now mitigated.

| Threat                                                  | Mitigation                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spoofing** of webhook senders                         | HMAC-SHA-256 over `${ts}.${rawBody}` with per-source secret; **`rawBody` is the captured request bytes, not `JSON.stringify(parsedBody)` (closed in Phase 0)**; ±5 min timestamp tolerance; `Idempotency-Key` shape-validated regex `^[A-Za-z0-9_-]{16,128}$` before Redis touch. Failure → 401 + `WEBHOOK_FAILED` audit. |
| **Spoofing** of session via CSRF                        | Double-submit cookie + header, both timing-safe compared, both verified under their own `CSRF_SIGNING_SECRET`. Opt-in `routeOptions.config.skipCsrf` flag on HMAC-authenticated webhook routes only (replaces the URL-prefix exemption that was path-traversal-bypassable — **closed in Phase 0**).                       |
| **Spoofing** via JWT kind-confusion                     | Per-kind JWT secrets (`access` / `refresh` / `ws_ticket` / `investor_scope`) dispatched through an exhaustive `secretFor(kind)` switch. **Closes the cross-kind forgery primitive** where a valid access token could be re-signed as a `ws_ticket` under the shared key (closed in Phase 0).                              |
| **Tampering** with audit trail                          | `audit_logs` and `revenue_events` have `REVOKE UPDATE/DELETE` at the runtime role; migration role (`eazepay_owner`) and runtime role (`eazepay_app`) are separate. Role-level REVOKE extension to other append-only tables (`webhook_events`, `outbox_events`, `credit_enrichments`) is Phase 1.6.                        |
| **Repudiation** of admin actions                        | Every mutation writes an `audit_log` row tagged `userId`, `orgId`, `action`, `ipAddress`, `userAgent`, `metadata`. Phase 1.5 makes the helper accept a `tx?: Prisma.TransactionClient` so the audit row participates in the same transaction as the mutation.                                                             |
| **Information disclosure** of PII at rest               | AES-256-GCM with a random IV per message; 1-byte version prefix enables key rotation without bulk re-encrypt. v2 envelope (per-tenant DEK wrapped under per-org KEK) lives in `tenant-dek.ts`; write-path adoption is Phase 2. `decryptPII` errors are generic — envelope structure stays in `error.cause` only.          |
| **Information disclosure** via decrypt error oracle     | All thrown decrypt errors are `'pii.decrypt_failed'`; specific cause (envelope_too_short, unknown_key_version, cipher_failed) lives only in `error.cause`. Closes the version-byte / key-id probe vector (closed in Phase 0).                                                                                             |
| **Information disclosure** via PAT table exfiltration   | API token secrets stored as `HMAC-SHA-256(secret, API_TOKEN_HASH_SECRET)` (replaces bare SHA-256; **closes the offline-crack risk** if `api_tokens` is exfiltrated — closed in Phase 0). Legacy SHA-256 fallback during rotation window.                                                                                  |
| **Information disclosure** via SSRF in outbound webhook | Pre-flight DNS resolution + reject on RFC1918 / loopback / link-local (incl. AWS metadata `169.254.169.254`) / carrier-grade NAT / IPv6 ULA / multicast / reserved. `redirect: 'manual'` so a 302 to a private IP cannot defeat the guard. Production requires HTTPS scheme. (Closed in Phase 0.)                         |
| **Information disclosure** via log-stream poisoning     | Inbound `x-request-id` regex-validated `^[0-9a-f-]{32,40}$` before being accepted into logs; falls through to a fresh UUIDv7 otherwise. Closes the SIEM-correlation poisoning vector (closed in Phase 0).                                                                                                                 |
| **DoS** at ingest                                       | Per-IP rate limit and per-user (cookie-auth) rate limit; composite IP+email rate limit on `/auth/login`; webhook bodies capped at the per-route `BODY_LIMIT_*` budget; BullMQ + Redis absorbs ingest bursts. `trustProxy: 1` — single Railway hop, no XFF spoof.                                                          |
| **DoS** via Redis-key flooding                          | `Idempotency-Key` regex-validated before Redis SETNX; key length capped at 128 chars. Closes the multi-MB key memory-exhaustion vector (closed in Phase 0).                                                                                                                                                               |
| **Elevation of privilege** between scopes               | RBAC checked at the route level (`requireRole`, `denyInvestorScope`); investor responses produced by separate response schemas; cookies are `HttpOnly` + `Secure` + `SameSite=None` in prod (cross-subdomain on `*.up.railway.app`). `__Host-` cookie prefix invariants (Secure + no Domain + Path=/) enforced in helper. |
| **Elevation of privilege** via cross-tenant data access | Row-level `orgId` declared on every tenant model (Phase 1 schema retrofit landed; call-site retrofit is Phase 1.5). RLS policies on 6 tables today; extension to the retrofitted ~20 tables is Phase 1.6.                                                                                                                 |

---

## Authentication

### Login + cookie flow

```
Browser ──POST /auth/login (email,password,mfaCode?)──► API
        ◄──Set-Cookie: epi_access (HttpOnly, 15 min, signed JWT)
        ◄──Set-Cookie: epi_refresh (HttpOnly, 7 day, rotated on every refresh)
        ◄──Set-Cookie: epi_csrf   (NOT HttpOnly, signed under CSRF_SIGNING_SECRET)

Browser ──fetch (any state-change)──► API
   header: X-CSRF-Token (mirror of epi_csrf)
   Server: timingSafeEqual(cookie, header) && hmacValid

Browser ──POST /auth/ws/ticket──► API   (cookie-authed, CSRF-checked)
        ◄── { ticket, expiresInSeconds: 30 }   (signed under JWT_WS_TICKET_SECRET)
Browser ──WS /ws/analytics?ticket=…──► API
   Server: GETDEL Redis key, upgrade if found
```

### JWT shape and secret separation

`apps/api/src/shared/utils/jwt.ts` defines four token kinds, each verified under its own secret:

| Kind             | Secret                      | TTL  | Stored where                    |
| ---------------- | --------------------------- | ---- | ------------------------------- |
| `access`         | `JWT_ACCESS_SECRET`         | 15 m | `epi_access` cookie (HttpOnly)  |
| `refresh`        | `JWT_REFRESH_SECRET`        | 7 d  | `epi_refresh` cookie (HttpOnly) |
| `ws_ticket`      | `JWT_WS_TICKET_SECRET`      | 30 s | Redis (`ws:ticket:*`)           |
| `investor_scope` | `JWT_INVESTOR_SCOPE_SECRET` | 60 m | `epi_access` (scope swap)       |

`secretFor(kind)` dispatches via an exhaustive `switch` — adding a new kind without a secret will fail TypeScript. The CSRF token signer uses `CSRF_SIGNING_SECRET`; the OAuth state HMAC uses `OAUTH_STATE_SECRET`. In dev, the new secrets are optional and fall back to `JWT_ACCESS_SECRET`; production refuses to boot if any of `JWT_WS_TICKET_SECRET`, `JWT_INVESTOR_SCOPE_SECRET`, `CSRF_SIGNING_SECRET`, `OAUTH_STATE_SECRET`, `API_TOKEN_HASH_SECRET`, `AWS_KMS_KEY_ARN` are unset.

### Refresh-token rotation

- Every successful refresh issues a new raw token, marks the old `revokedAt = now()`, sets `replacedBy` linkage, persists family id.
- Reuse of an already-revoked token in the family triggers a **family-wide revoke** (theft detection).
- Phase 3 adds `scope`/`orgId`/`sessionId` to the row so a refresh after Membership revocation can be rejected.

### CSRF

`apps/api/src/shared/middleware/csrf.middleware.ts` enforces double-submit:

1. Safe methods (GET/HEAD/OPTIONS) skip.
2. Routes that declare `routeOptions.config.skipCsrf === true` skip — the **only** webhook + integration routes set this, at registration time. The previous `req.url.startsWith('/api/v1/webhooks/')` check was path-traversal-bypassable.
3. Bearer-auth callers (PAT in `Authorization` header) skip — they're not session-cookie-bound. Detection is on the header itself (case-insensitive `^bearer\s+`), not on `req.auth` which may not be populated yet.
4. `/auth/login` skips (no session yet; rate-limited per (ip,email)).
5. Cookie and `X-CSRF-Token` header compared with `timingSafeEqual` and a length pre-check.
6. Signature verified via `verifyCsrfToken` (HMAC under `CSRF_SIGNING_SECRET`, timing-safe).

### API tokens (PATs)

Token shape: `epi_pk_<8-byte prefix>_<24-byte secret>` (`apps/api/src/shared/utils/api-token.ts`).

Storage: prefix is indexed and visible; secret half is stored as `HMAC-SHA-256(secret, API_TOKEN_HASH_SECRET)` hex. The pepper turns the `api_tokens` table into a useless artefact if exfiltrated — the attacker also needs the application secret to brute-force the 192-bit secret entropy offline.

Migration window: when `API_TOKEN_HASH_SECRET` is unset (dev, or pre-rotation prod), `hashSecret` falls back to bare SHA-256 so existing tokens still verify. Production startup asserts the pepper is set, so the fallback path is unreachable in production. Long-term plan (Phase 3): add a `hashVersion` column and dual-verify during a 90-day rotation window, then drop the legacy path.

### MFA

TOTP enrolled per-user, validated on `/auth/login`. Phase 3 adds a per-user MFA rate limiter (`mfa:fail:${userId}`, max 5 / 90s, lockout at 10 / hour) so the shared login rate-limit bucket can't be brute-forced.

---

## Webhook ingress

`apps/api/src/shared/middleware/webhook-signature.middleware.ts` is the single entry point for all signed inbound traffic (Pixie, MiCamp, EazePay App, HighSale).

Order of operations:

1. Headers `x-eazepay-signature`, `x-eazepay-timestamp`, `Idempotency-Key` must be present.
2. `Idempotency-Key` regex `^[A-Za-z0-9_-]{16,128}$` (caps length, confines charset — prevents multi-MB Redis-key flood and Redis-namespace collision).
3. Timestamp within ±300 seconds.
4. HMAC-SHA-256 over `${ts}.${rawBody}` compared `timingSafeEqual`. **`rawBody` is the captured request bytes** — `apps/api/src/server.ts` registers a JSON content-type parser that sets `req.rawBody: string` before parsing. The HMAC signs against the exact bytes the vendor signed; `JSON.stringify(req.body)` was not byte-exact and broke verification on any non-canonical JSON (key ordering, whitespace, integer precision, unicode escapes).
5. Redis `SETNX idem:{source}:{key}` (24h TTL) — hot replay short-circuit.
6. Postgres unique on `(source, idempotency_key)` in `webhook_events` — cold fallback, durable forever.

The DB layer is the source of truth; Redis is the cache. Each layer maps a hit to a 202 with cached metadata. The route handler runs only on first-time events and writes the outbox row in the same transaction as the `WebhookEvent` upsert (atomicity gap SEC-116 still to be closed — Phase 5).

---

## PII handling

PII fields (`consumerName`, `consumerEmail`, `consumerPhone`):

- **At rest:** AES-256-GCM. Two envelope formats coexist on the read path:
  - **v1** (legacy): `[version:1=0x01][iv:12][authTag:16][ciphertext:N]` under the global `PII_ENCRYPTION_KEY`. Decoded by `decryptPII` in `shared/utils/encryption.ts`.
  - **v2** (per-tenant): `[version:1=0x02][algorithm:1][keyId:16][iv:12][ciphertext:N][tag:16]` under a per-org DEK that is itself KMS-wrapped (`tenant-dek.ts`). Decoded by `decryptEnvelopeV2`. **Read path is wired; write-path adoption is Phase 2.**
- **For lookup:** deterministic `HMAC-SHA-256(plaintext, PII_HASH_SECRET)`, stored in a separate `*_hash` column with a btree index. Constant-time `hashesEqual` for compares.
- **For display:** masked by default in list responses (`b****@example.com`); raw values returned only by `/applications/:id/pii` (admin/operator only, denied under investor scope, `PII_ACCESSED` audit).
- **In logs:** Pino redacts paths matching `*.consumerName | *.consumerEmail | *.consumerPhone | *.passwordHash | *.password | *.mfaSecret | *.tokenHash | …`.

### Key management

- **KEK provider:** `KmsClient` interface (`apps/api/src/shared/kms/kms-client.interface.ts`) abstracts the provider. Two implementations:
  - `AwsKmsClient` — AWS KMS in `ap-southeast-2`. Production. `isProductionGrade = true`.
  - `LocalKmsClient` — HKDF-derived in-process KEK. Dev / CI. `isProductionGrade = false`.

- **Production-grade gate:** `LocalKmsClient`'s constructor throws if `NODE_ENV === 'production'` — a misconfigured deploy with `AWS_KMS_KEY_ARN` unset cannot silently fall through to a deterministic HKDF key. `cryptoshredOrg` hard-asserts `kms.isProductionGrade === true` before any DB mutation — refuses to "succeed" on a staging environment where the key material is intact, which would otherwise be a GDPR Art. 17 / APP 11 lie if claimed as completing an erasure request.

- **DEK cache:** in-process LRU keyed on `(orgId, keyId)`, TTL 1 h. `evict(orgId)` API for cryptoshred eviction is Phase 2.

- **Generic decrypt errors:** every thrown decrypt error message is `'pii.decrypt_failed'`. The specific reason (envelope_too_short / unknown_key_version:N / cipher_failed) is attached via `error.cause` so internal log capture can pull it structurally without leaking envelope structure to anyone who can submit ciphertext and observe error responses.

### RTBF (Right to be Forgotten)

- **Mode A — PII scrub:** `RtbfService.processInner` overwrites `applications.consumerName/Email/Phone` ciphertext + hash columns with sentinel values. In production today.
- **Mode B — cryptoshred:** `cryptoshredOrg(prisma, orgId)` calls `kms.scheduleKeyDeletion` on every active `TenantEncryptionKey` for the org. After the pending window expires, the wrapped DEKs are unrecoverable and all v2 ciphertext encrypted under those DEKs is irrecoverable. Hard-gated on `isProductionGrade` KMS.
- **Gap (GAP-111, queued):** RTBF currently scrubs `applications` only; `credit_enrichments` (HighSale PII echo) survives erasure. Phase 2 extends `processInner` to scrub credit-enrichment rows on `emailHash` match. Better long-term: store enrichment payload encrypted under per-org DEK at receive time so Mode B kills it.

---

## API surface — headers

### API tier (`apps/api/src/server.ts`)

Helmet configured for a JSON-only API:

- **HSTS** `max-age=31536000; includeSubDomains; preload` (1 year + preload).
- **CSP** locked to `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`. No script, no inline, no third-party origins — the API is JSON in / JSON out.
- **Cross-Origin-Opener-Policy** `same-origin`.
- **Cross-Origin-Resource-Policy** `same-site` (web on sibling subdomain).
- **Referrer-Policy** `no-referrer`.

`trustProxy: 1` — single Railway hop. `bodyLimit` per-route via `BODY_LIMIT_*` env. Default 1 MiB.

### Web tier (`apps/web/next.config.mjs`)

Previously zero security headers — the web is what owns the auth cookies; a single React-side XSS would have drained `HttpOnly` cookies via a token-stealing redirect with nothing to stop it. Now (closed in Phase 0):

- **HSTS** 1 year + `includeSubDomains` + `preload`.
- **CSP** computed from `NEXT_PUBLIC_API_URL`: `default-src 'self'`; `script-src 'self'` (no inline); `style-src 'self' 'unsafe-inline'` (Next injects critical inline CSS without a nonce hook — scoped to styles only, does not weaken script protection); `connect-src 'self' + api + ws`; `frame-ancestors 'none'`; `object-src 'none'`.
- **Referrer-Policy** `strict-origin-when-cross-origin`.
- **Permissions-Policy** denies every feature the dashboard doesn't use (camera, mic, geolocation, payment, USB, MIDI, …).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, COOP `same-origin`, CORP `same-site`.

---

## Multi-tenancy

The codebase is mid-retrofit from the single-tenant v0.1 model to a row-scoped multi-tenant model.

**Today's state:**

- Every tenant model carries an `orgId` column at the schema level (Phase 1 retrofit landed in `feat/phase-1-multitenant-retrofit`). ~30 tables affected. Composite indexes on `[orgId, createdAt]` for list endpoints. Per-org composite uniques replace the previously-global uniques on `Partner.externalId`, `RevenueEvent.(source, idempotencyKey)`, `WebhookEvent.(source, idempotencyKey)`, `Tag.name`, `CreditEnrichment.highsaleTransactionId`.
- New `WebhookSource` enum values for the missing planes: `EAZEPAY_APP`, `HIGHSALE`, `AUREAN_AI`, `AUREAN_RECRUITMENT`. New `ApplicationStatus` values: `OFFERED`, `CONTRACTED`, `QUARANTINE`.
- Bootstrap-org helper (`apps/api/src/shared/tenant/bootstrap-org.ts`) returns a single-tenant fallback for call sites that don't yet have `orgId` in scope (used during the Phase 1.3 → 1.5 transition).
- RLS policies on 6 tables today (`applications`, `audit_logs`, `revenue_events`, `webhook_events`, `outbox_events`, `lender_decisions`); extension to the rest is Phase 1.6.

**Queued:**

- ~20 call sites still need `orgId` threaded into Prisma `create` payloads (Phase 1.5 — see docs/reviews/HARDENING.md F1.5).
- `eazepay_app` Postgres role with `NOBYPASSRLS` and `REVOKE UPDATE, DELETE` on all append-only tables (Phase 1.6).
- `FORCE ROW LEVEL SECURITY` swap-in once every retrofitted table has a policy (Phase 1.6).
- `withTenantSession` wired as a Fastify `preHandler` that sets `app.org_id` GUC per request (Phase 1.6).

Until Phase 1.5 is complete, **the codebase is safe only because Brodie is the only ADMIN of every org and holds `PlatformRole.SUPER`**. The next user invited to a second org is the test case.

---

## Audit log

Every state-changing transaction writes one `audit_log` row tagged with `userId`, `orgId`, `action`, `resourceType`, `resourceId`, `metadata`, `ipAddress`, `userAgent`. Helper at `apps/api/src/shared/middleware/audit-log.middleware.ts`.

- `audit_logs` and `revenue_events` have `REVOKE UPDATE, DELETE` at the runtime role (`eazepay_app`); migrations run as `eazepay_owner`.
- `orgId` is resolved in order: explicit arg → `req.auth.orgId` (set by tenant-resolution middleware, Phase 1.3) → `null` (platform-level event, visible only to platform-staff cross-tenant audit views).
- Phase 1.5 makes the helper accept `tx?: Prisma.TransactionClient` so the audit row is in the same transaction as the mutation. Today it's a separate connection — the audit can succeed when the mutation rolls back, or vice versa.

---

## Outbound webhooks

`OutboundWebhookService` (`apps/api/src/domains/outbound-webhooks/`) fans internal events to subscriber URLs.

- **SSRF allowlist** runs at both registration time and delivery time. `assertPublicHostname(url)`:
  - HTTPS-only in production (HTTP allowed for dev / mock).
  - If the literal hostname is an IP, gate it directly.
  - Else DNS-resolve `all: true` and check every record. Reject if any address is in RFC1918 (10/8, 172.16/12, 192.168/16) / loopback (127/8, ::1) / link-local (169.254/16 including AWS metadata, fe80::/10) / carrier-grade NAT (100.64/10) / IPv6 ULA (fc00::/7) / multicast / reserved.
- `redirect: 'manual'` — a 302 to a private IP would defeat the pre-flight check. Manual handling means the worker treats a 3xx as a delivery outcome, not a follow-through.
- Response body size capped at read time.
- Signing secret stored hashed; signing payload **should** use the plaintext secret (subscriber can verify). **Today** the signer uses the hash (SF-019); Phase 3 stores the secret encrypted at rest and signs with the plaintext.

---

## Rate limiting

`@fastify/rate-limit` per-route tiers (`apps/api/src/shared/middleware/rate-limit-tiers.ts`):

- **Anonymous** — `RATE_LIMIT_PER_IP_PER_MIN` (default 100). Tight; protects `/auth/login` and public surfaces.
- **Authenticated session/PAT** — `RATE_LIMIT_PER_USER_PER_MIN` (default 1000). Per-user (not per-IP) so devs behind a NAT aren't punished. Falls back to IP if no auth context.
- **Ingestion** — `RATE_LIMIT_INGESTION_PER_MIN` (default 6000). Sized for 1 k-row/min sustained ETL.
- **Webhook ingress** — `RATE_LIMIT_WEBHOOK_PER_MIN` (default 10000). Sized for vendor retry storms.

`skipOnError: false` at the plugin level — Redis-down means 503 rather than fail-open. Pipe-level fail-open (`.catch(()=>{})` on the MULTI exec inside the limiter) is flagged for Phase 5 (SF-003).

---

## Secret strategy

| Secret                                                   | Format            | Production-required? | Rotation                                                                                |
| -------------------------------------------------------- | ----------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                                      | string ≥32 chars  | yes                  | RS256+KMS deferred to v1.1                                                              |
| `JWT_REFRESH_SECRET`                                     | string ≥32 chars  | yes                  | same                                                                                    |
| `JWT_WS_TICKET_SECRET`                                   | string ≥32 chars  | **yes (Phase 0)**    | rotation invalidates in-flight WS tickets only (30 s TTL)                               |
| `JWT_INVESTOR_SCOPE_SECRET`                              | string ≥32 chars  | **yes (Phase 0)**    | rotation forces all investor-scope sessions to re-issue                                 |
| `CSRF_SIGNING_SECRET`                                    | string ≥32 chars  | **yes (Phase 0)**    | rotation invalidates in-flight CSRF cookies; users get one 403 on next mutation         |
| `OAUTH_STATE_SECRET`                                     | string ≥32 chars  | **yes (Phase 0)**    | rotation invalidates in-flight OAuth flows (≤5 min)                                     |
| `API_TOKEN_HASH_SECRET`                                  | string ≥32 chars  | **yes (Phase 0)**    | rotation requires re-hash of `api_tokens` rows; dual-hash window planned in Phase 3     |
| `PII_ENCRYPTION_KEY`                                     | base64 32 bytes   | yes                  | version-byte rotation; v2 envelope (per-org DEK) replaces this for new writes (Phase 2) |
| `PII_HASH_SECRET`                                        | string ≥16 chars  | yes                  | rotation requires re-hashing all PII; do not rotate without a backfill plan             |
| `AWS_KMS_KEY_ARN`                                        | KMS key ARN       | **yes (Phase 0)**    | per-org KEK strategy in v2 — see ADR-002                                                |
| `PIXIE / MICAMP / EAZEPAY_APP / HIGHSALE_WEBHOOK_SECRET` | string ≥16 or ≥32 | yes                  | coordinate with each upstream; overlap window via secondary verification (Phase 5)      |

**Production-only assertions** (`apps/api/src/config/env.ts`): refuses to boot if a sensitive secret contains the substring `local-dev`, has fewer than 16 distinct characters (basic entropy floor), or if any of the per-kind / per-pepper / KMS-ARN secrets above marked **yes (Phase 0)** are unset.

---

## Database role hardening

Two Postgres roles in production:

- **`eazepay_owner`** — owns schema, runs migrations.
- **`eazepay_app`** — runtime role. Has `SELECT/INSERT/UPDATE/DELETE` on most tables; `REVOKE UPDATE, DELETE` on `audit_logs` and `revenue_events`. `apps/api/prisma/init-timescale.sql` enforces the REVOKE conditionally if the app role exists.

**Phase 1.6 work** (queued): extend `REVOKE` to `webhook_events`, `outbox_events`, `credit_enrichments`. Add `NOBYPASSRLS` to `eazepay_app` and `FORCE ROW LEVEL SECURITY` on every tenant table once policies are in place. Add a startup assertion that the API's DB user does not have `BYPASSRLS`.

---

## Incident response

1. **Detect** — `/admin → Webhook events` shows `FAILED` rows; `audit_logs` shows `WEBHOOK_FAILED` with error string. Alerting wiring deferred to v1.1.
2. **Contain** — rotate the offending source's webhook secret in Railway env (vendor will fail signature → 401, no further events accepted).
3. **Investigate** — webhook payload is durably stored on the `WebhookEvent` row; replay manually against the worker after fix.
4. **Recover** — `/admin → Webhook events → Replay` button re-enqueues a failed event. Processor is idempotent on `(orgId, source, idempotencyKey)` so safe to retry.
5. **Postmortem** — write up; if PII was accessed inappropriately, audit log shows exact `userId` + `orgId` + `applicationId` + timestamp.

---

## Supply-chain controls

Every PR runs four scans, each gated as a required check:

| Tool                                             | Surface                                                   | Fails on         |
| ------------------------------------------------ | --------------------------------------------------------- | ---------------- |
| `pnpm audit --audit-level=high` (prod deps only) | Lockfile advisory matches                                 | HIGH or CRITICAL |
| Trivy (fs mode)                                  | Resolved deps incl. transitives                           | HIGH or CRITICAL |
| CodeQL (`security-extended`)                     | TypeScript AST — injection, ReDoS, hardcoded-secret flows | any finding      |
| Trivy (image mode)                               | Container layers + base image                             | HIGH or CRITICAL |

Each Trivy run uploads a SARIF to GitHub Code Scanning. A CycloneDX SBOM is generated from the container image and attached as a 90-day workflow artefact. Dependabot raises PRs as new advisories land; the same gates apply.

**Outstanding upgrades (Phase 4):** Next.js 14 → 15.5.16+ (4 high-severity advisories), Fastify 4 → 5.7.2+ (Content-Type tab body-validation bypass), `@opentelemetry/sdk-node` 0.54 → 0.217+. Pinned in docs/reviews/HARDENING.md F4.

---

## What's solid (leave it alone)

The inverse of the punch list. These primitives were validated by the five-agent review and are unchanged in Phase 0:

- **Password hashing** — argon2id at OWASP-recommended cost (`memoryCost: 64 MiB`, `timeCost: 3`, `parallelism: 4`). `apps/api/src/shared/utils/password.ts`. Phase 0 added warn-level logging on `argon2.verify` errors so a corrupted hash row stops looking identical to a wrong password.
- **AES-256-GCM envelope** — random IV per message, version-byte prefix for rotation, explicit auth-tag handling. v1 (`encryption.ts`) and v2 (`tenant-dek.ts`) share the same primitive. Gap: AAD binding for confused-deputy resistance is Phase 2.
- **Refresh-token rotation** — reuse-detect → family revocation. HMAC-keyed storage in `auth.repository.ts`. Phase 3 binds `scope`/`orgId`/`sessionId` to the row.
- **JWT signature verify** — timing-safe with length pre-check. `jwt.ts`. Per-kind secrets (Phase 0) closed the cross-kind forgery primitive.
- **Two-layer webhook idempotency** — Redis SETNX hot path + Postgres `(source, idempotencyKey)` unique cold fallback. The pattern Stripe uses for the same problem.
- **404-not-403 on cross-tenant org lookups** — `auth.middleware.ts` returns the same shape for non-existent and unauthorised orgs.
- **`denyInvestorScope` middleware** — positive belt-and-braces gate on routes that must never return investor payloads.
- **Per-tenant DEK envelope v2 design** — `tenant-dek.ts`. Per-org keyId in header, KMS lazy unwrap, cryptoshred operational. Gap is write-path adoption (Phase 2).
- **"Surgical escape" GUCs** — `withInvitationLookup`, `withBearerLookup` each gate a single read narrowly rather than punching a hole in RLS.
- **Plugin order** — `helmet → cors → sensible → rate-limit → websocket → auth → routes`. Correct.
- **Decimal-safe reply serializer** — `server.ts` preserves `Prisma.Decimal` precision through Fastify's reply path.
- **Per-route body limit** — configurable via `BODY_LIMIT_*` env, default 1 MiB. Routes that genuinely need more declare it explicitly.

---

## Vulnerability disclosure

Email `security@eazepay.local`. We aim to acknowledge in 24 h, patch high-severity in 7 days. Please don't run automated scanners against production hosts without prior notice.
