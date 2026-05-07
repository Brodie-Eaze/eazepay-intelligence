# Security · EazePay Intelligence

This document is the technical security narrative. For the auditor-facing control mapping see [`docs/governance/SOC2_CONTROLS.md`](docs/governance/SOC2_CONTROLS.md). For data classification and PII handling see [`docs/governance/PRIVACY.md`](docs/governance/PRIVACY.md) + [`docs/governance/DATA_CLASSIFICATION.md`](docs/governance/DATA_CLASSIFICATION.md).

## Threat model (STRIDE)

| Threat                                    | Mitigation                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spoofing** of webhook senders           | HMAC SHA-256 over `${ts}.${rawBody}` with per-source secret; ±5 min timestamp tolerance; `Idempotency-Key` deduplication. Failure → 401 + audit row.                                |
| **Tampering** with audit trail            | `audit_logs` and `revenue_events` REVOKE UPDATE/DELETE at the runtime role; the migration role and runtime role are separate (`eazepay_owner` vs `eazepay_app`).                    |
| **Repudiation** of admin actions          | Every mutation writes an `audit_log` row with `userId`, `action`, `ipAddress`, `userAgent`, `metadata` in the same transaction.                                                     |
| **Information disclosure** of PII         | AES-256-GCM at rest; key versioning byte enables rotation; PII reveal is admin/operator only and audit-logged via `PII_ACCESSED`; logger redacts known PII paths.                   |
| **DoS** at ingest                         | Per-IP rate limit (Fastify), composite IP+email rate limit on `/auth/login`, webhook bodies capped at 1 MiB, BullMQ + Redis absorbs ingest bursts.                                  |
| **Elevation of privilege** between scopes | RBAC checked at the route level (`requireRole`, `denyInvestorScope`); investor responses produced by _different_ response schemas; cookies are httpOnly + Secure + SameSite=Strict. |

## Authentication flow

```
Browser ──POST /auth/login (email,password,mfaCode?)──► API
        ◄──Set-Cookie: epi_access (httpOnly, 15 min)
        ◄──Set-Cookie: epi_refresh (httpOnly, 7 day, rotated)
        ◄──Set-Cookie: epi_csrf   (NOT httpOnly, signed)

Browser ──fetch (any state-change)──► API
   header: X-CSRF-Token (mirror of epi_csrf)
   Server validates: cookieEqualsHeader && hmacValid

Browser ──POST /auth/ws/ticket──► API   (cookie-authed, CSRF-checked)
        ◄── { ticket, expiresInSeconds: 30 }
Browser ──WS /ws/analytics?ticket=…──► API
   Server: GETDEL Redis key, upgrade if found
```

### Refresh token rotation

- Every successful refresh issues a new raw token, marks the old as `revokedAt = now()`, sets `replacedBy` linkage, and persists family id.
- Reuse of an already-revoked token in the family triggers a **family-wide revoke** (theft detection).

## PII handling

PII fields (`consumerName`, `consumerEmail`, `consumerPhone`):

- **At rest:** `[version:1][iv:12][authTag:16][ciphertext:N]` — AES-256-GCM. `PII_ENCRYPTION_KEY` is base64 32 bytes.
- **For lookup:** deterministic HMAC-SHA-256 hash with `PII_HASH_SECRET` pepper, stored as separate `*_hash` column with btree index.
- **For display:** masked by default in `/applications` responses (`b****@example.com`); raw values returned only by `/applications/:id/pii` (admin/operator only, denied under investor scope).
- **In logs:** Pino redacts paths matching `*.consumerName | *.consumerEmail | *.consumerPhone | *.passwordHash | *.password | *.mfaSecret | *.tokenHash | …`.

### Key management — current state and the v1.1 envelope upgrade

**Today (v0.1):** `PII_ENCRYPTION_KEY` is loaded once at process boot from the
environment. Every PII row in the corpus is encrypted under the same KEK
(key-encryption key, version 1). The 1-byte version prefix on every ciphertext
envelope means we can rotate to a v2 KEK without re-encrypting the corpus —
new writes use v2, reads honour the per-row version byte, and we let v1
ciphertext age out naturally.

**Honest gap:** there is no per-row data-encryption key (DEK). The whole
corpus shares a single KEK. If that KEK is exfiltrated, the entire historical
PII set is compromised at once.

**v1.1 hardening (envelope encryption):**

1. Each row gets a freshly-generated per-row 32-byte DEK
2. The DEK encrypts the PII; the DEK itself is encrypted by the KEK and stored
   alongside the ciphertext
3. The KEK lives in AWS KMS / 1Password / GCP KMS — never in the application
   environment, never on disk
4. Rotation rotates the KEK only; DEKs are touched lazily on next write to a
   given row, or eagerly via a backfill job

This is the standard pattern at financial platforms that hold PII at scale
(Stripe, Plaid, Block). It is documented in `docs/ROADMAP.md` P1 alongside
the secrets-vendor decision. The architectural placeholder is already in
`encryption.ts`'s `KEY_VERSIONS` map — extending it from "version → KEK" to
"version → KMS key reference" is mechanical when KMS lands.

## Secret strategy

| Secret                                | Format                   | Rotation                                                                                 |
| ------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                   | string ≥32 chars (HS256) | RS256+KMS deferred to v1.1                                                               |
| `JWT_REFRESH_SECRET`                  | string ≥32 chars (HS256) | same                                                                                     |
| `PII_ENCRYPTION_KEY`                  | base64 32 bytes          | versioning supported (envelope byte 0); add v2 key, transition writes, decrypt-as-needed |
| `PII_HASH_SECRET`                     | string ≥16 chars         | rotation requires re-hashing all PII; do not rotate without a backfill plan              |
| `BUZZPAY/PIXIE/MICAMP_WEBHOOK_SECRET` | string ≥16 chars         | coordinate with each vendor; supports overlap window via secondary verification (v1.1)   |

Secrets live in `.env` for v1. Production roadmap: AWS KMS / 1Password Secrets Automation (vendor TBD).

## Database role hardening

Two roles required in production:

- `eazepay_owner` — owns schema, runs migrations.
- `eazepay_app` — runtime role, has SELECT/INSERT/UPDATE/DELETE on most tables but UPDATE/DELETE **revoked** on `audit_logs` and `revenue_events`.

`apps/api/prisma/init-timescale.sql` enforces the REVOKE if the app role exists.

## Incident response

1. **Detect** — `/admin → Webhook events` shows `FAILED` rows; `audit_logs` shows `WEBHOOK_FAILED` with error string. Alerting wiring deferred to v1.1.
2. **Contain** — toggle the offending source's webhook secret in `.env` to a new value (vendor will fail signature → 401, no further events accepted).
3. **Investigate** — webhook payload is durably stored on the `WebhookEvent` row; replay manually against the worker after fix.
4. **Recover** — `/admin → Webhook events → Replay` button re-enqueues a failed event. The processor is idempotent on `(source, idempotency_key)` so safe to retry.
5. **Postmortem** — write up; if PII was accessed inappropriately, audit log shows exact `userId` + `applicationId` + timestamp.

## Supply-chain controls

Every PR runs four scans, each gated as a required check:

| Tool                                             | Surface                                                   | Fails on         |
| ------------------------------------------------ | --------------------------------------------------------- | ---------------- |
| `pnpm audit --audit-level=high` (prod deps only) | Lockfile advisory matches                                 | HIGH or CRITICAL |
| Trivy (fs mode)                                  | Resolved deps incl. transitives                           | HIGH or CRITICAL |
| CodeQL (`security-extended`)                     | TypeScript AST — injection, ReDoS, hardcoded-secret flows | any finding      |
| Trivy (image mode)                               | Container layers + base image                             | HIGH or CRITICAL |

Each Trivy run uploads a SARIF to GitHub Code Scanning. A CycloneDX SBOM is generated from the container image and attached to every workflow run as a 90-day artifact — ready to ship with a release for downstream attestation.

Dependabot (`.github/dependabot.yml`) raises PRs as new advisories land; those PRs run the same gates so a regression-introducing bump can't merge.

## Vulnerability disclosure

Email security@eazepay.local. We aim to acknowledge in 24h, patch high-severity in 7 days. Please don't run automated scanners against production hosts without prior notice.
