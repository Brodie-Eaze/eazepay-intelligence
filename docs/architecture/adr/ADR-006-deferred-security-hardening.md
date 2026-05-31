# ADR-006 · Deferred Security Hardening (SEC-005 + SEC-006)

> **Status**: Open. Targets next quarter, before tenant #2 onboarding.
> **Date**: 2026-05-17
> **Context**: Adversarial security audit ahead of external pen-test (elttam / Trail of Bits).

## Summary

The 2026-05-17 hardening pass closed 7 of 9 HIGH-severity findings from
the adversarial audit. Two findings — **SEC-005** (per-tenant webhook
secrets) and **SEC-006** (AAD binding on the v2 encryption envelope) —
are deferred because they require either a contract change with
external partners (SEC-005) or a forward-compatible envelope version +
data migration (SEC-006). Both are documented here as committed work
ahead of tenant #2 onboarding.

## SEC-005 · Per-tenant webhook secrets

### What's broken

`EAZEPAY_APP_WEBHOOK_SECRET` and `HIGHSALE_WEBHOOK_SECRET` are single
global env-var values, shared across all tenants. The signature only
proves _"someone with the global secret sent this"_; it does NOT bind
which tenant the event belongs to. The orgId is currently derived from
a body field (`data.brand` for EAZEPAY, `vertical` for HIGHSALE), which
is spoofable by any party who learns the global secret.

### Why deferred

The system is currently single-tenant in production. Spoofing requires
a second tenant to exist before there's anything to spoof to. The
finding is genuinely high-severity but unexploitable at our current
scale.

The fix requires a contract change with external partners:

1. Each tenant registers their own signing secret(s) in
   `webhook_credentials` (table already exists per Phase 1 migrations).
2. Senders include a credential identifier in every request — options
   include `X-Webhook-Credential-Id` header, path scoping
   (`/integration/highsale/:credentialId/snapshots`), or subdomain
   scoping (`tenant-a.api.example.com/...`).
3. Middleware looks up the credential by id, verifies the HMAC against
   the credential's secret (not the env var), and uses the credential's
   `orgId` as the event's tenancy — never the body.

Each of HighSale and EazePay App will need their own implementation
work to send the credential identifier. That's a coordinated rollout,
not an in-flight refactor.

### Recommended design (for the implementation PR)

- **Header**: `X-Webhook-Credential-Id: <uuid>` (low ceremony, no path
  refactor, no DNS change).
- Middleware order:
  1. Parse `X-Webhook-Credential-Id`. If absent, fall through to the
     env-var path (backward-compat window).
  2. Look up `webhook_credentials` by id. Reject 401 if missing.
  3. Verify HMAC against `credential.secretHash` (already-hashed at
     storage time; see SEC-021 separate note about that pattern).
  4. Use `credential.orgId` as the `WebhookEvent.orgId`. The body's
     `brand` / `vertical` field becomes informational only — it's
     written to `WebhookEvent.payload` for audit but never used for
     tenancy.
- **Backward compat**: the env-var fallback stays in place for 90 days
  past first tenant migration. Each tenant is migrated individually;
  the env-var is removed when the LAST tenant is on credentials.
- **Telemetry**: log every fallback to env-var path at `info` level
  with the (clamped) idempotency-key prefix so ops can see who's still
  on the legacy path.

### Acceptance criteria

- New `X-Webhook-Credential-Id` header path implemented end-to-end for
  HighSale + EazePay App.
- Integration test: two tenants register distinct credentials, a
  request signed by tenant-A's secret cannot be authenticated as
  tenant-B (signature mismatch).
- Negative integration test: a request with valid signature but
  `data.brand` set to tenant-B's slug still lands in tenant-A's data.
- Migration guide written for HighSale + EazePay App teams.
- Env-var deprecation banner added to startup logs.

---

## SEC-006 · AAD binding on v2 encryption envelope

### What's broken

`apps/api/src/shared/kms/tenant-dek.ts:383-415` constructs v2 envelopes
as `[version, algorithm, keyId, iv, ct, tag]` with no Additional
Authenticated Data passed to `cipher.setAAD()`. The `keyId` is
self-describing in the envelope, so an attacker with DB write access
can:

- Copy `consumer_email_ciphertext` bytes from org A's application row
  into org B's row, into a different application's
  `consumer_name_ciphertext` slot, or even cross-table.
- The bytes decrypt successfully under the original org A DEK (which
  is still active and resolvable via the embedded keyId).
- Result: row-level data injection / impersonation that the cipher
  cannot detect.

### Why deferred

The exploit precondition is **attacker has DB write access**. At that
point the AAD layer is defence-in-depth, not the primary control.
Higher-priority is closing application-layer paths that could grant
DB write access (which we've done: SEC-001 + SEC-002 + SEC-003 +
SEC-004).

The fix itself requires a new envelope version (v3) because adding
AAD to v2 in-place would break every existing ciphertext (the cipher
tag was computed without AAD, so an AAD-aware decrypt rejects it). A
data migration re-encrypts existing rows under v3 — non-trivial
because it must run under tenant context (RLS) for every row.

### Recommended design (for the implementation PR)

- **New envelope version 0x03** with byte layout
  `[0x03, algorithm, keyIdLen, keyId, iv, ct, tag]` — same as v2 plus
  an explicit AAD-was-set marker.
- **AAD bytes** = `${orgId}:${rowId}:${columnName}` UTF-8.
- **`encryptForOrg` signature change**:
  ```
  encryptForOrg(orgId, plaintext, aad: { rowId, columnName })
  ```
  `aad` becomes required on new writes. Call-sites that don't have
  `rowId` at encryption time (first INSERT, where the id is generated
  by Prisma) use a two-step: insert with placeholder ciphertext, then
  UPDATE with the real ciphertext and the now-known `rowId`. Or use
  Postgres `RETURNING id` to pipeline.
- **`decryptEnvelopeAuto`** dispatcher:
  - v1 (0x01) → legacy global-key path, no AAD (existing behaviour)
  - v2 (0x02) → per-org DEK, no AAD (existing behaviour)
  - v3 (0x03) → per-org DEK, AAD required and passed by caller
- **Data migration**: background worker walks every encrypted column
  in every table, decrypts v1/v2, re-encrypts as v3 with proper AAD.
  Wrapped in `withTenantSession` per row. Idempotent — already-v3
  rows are skipped.
- **Cutover**: after data migration completes, gate new writes to
  v3-only via a feature flag. v1/v2 decrypt paths stay forever for
  forensic readback of backups.

### Acceptance criteria

- v3 envelope implemented + decryption test for v1/v2/v3 round-trip.
- `encryptForOrg` requires AAD on every call (TypeScript signature
  enforces).
- Negative test: bytes copied from one row's ciphertext column into
  another row fail to decrypt (cipher tag mismatch under different
  AAD).
- Migration worker implemented and runs against full dev DB without
  data loss.
- Feature flag flipped to v3-only after migration completes.

---

## Timing

| Finding | Effort                                              | Target                     | Blocker                                       |
| ------- | --------------------------------------------------- | -------------------------- | --------------------------------------------- |
| SEC-005 | ~2 weeks engineering + 4 weeks partner coordination | Before tenant #2           | HighSale + EazePay App partner implementation |
| SEC-006 | ~1 week engineering + background migration          | Before SOC 2 Type II audit | None (can start now)                          |

## Cross-references

- Adversarial audit summary: this conversation transcript (2026-05-17)
- Closed in PR #5: SEC-001, SEC-002, SEC-003, SEC-014
- Closed in PR after this ADR: SEC-004, SEC-007, SEC-008, SEC-009,
  SEC-011, SEC-016 (plus AES-GCM authTag, pino redaction)
- Deferred (this ADR): SEC-005, SEC-006
- Subsumed: SEC-019 (will be resolved structurally when SEC-005 lands —
  proper webhook-credentials lookup replaces the bootstrap orgId
  fallback)
