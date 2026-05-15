# ADR-002 — Per-Tenant Envelope Encryption (KMS-wrapped DEK)

**Status:** ACCEPTED
**Date:** 2026-05-08
**Deciders:** Brodie
**Supersedes:** the global `PII_ENCRYPTION_KEY` pattern from project inception
**Related:** ADR-001 (Multi-Tenancy)

---

## Context

Today, `apps/api/src/shared/utils/encryption.ts` implements AES-256-GCM with a single process-global key (`PII_ENCRYPTION_KEY`). Envelope: `[version:1][iv:12][tag:16][ciphertext:N]`. HMAC-SHA-256 hashes (`consumerEmailHash`, `consumerPhoneHash`) use a global `PII_HASH_SECRET` pepper. RTBF zeros ciphertext bytes.

Two structural gaps:

1. A single compromised key exposes all tenants' PII across all time.
2. RTBF by zeroing leaves key material intact; with backups + cross-region replication, "delete" becomes fragile.

Goal: replace the global key with **per-tenant Data Encryption Keys (DEK)** wrapped by a **Key Encryption Key (KEK)** held in a managed KMS, without a flag-day re-encryption.

---

## Decision

- **KMS provider:** **AWS KMS (ap-southeast-2 / Sydney)** as production default, behind a `KmsClient` interface so any provider is swappable. `LocalKmsClient` for developer workstations.
- **DEK granularity:** **one DEK per Organization** (the tenant unit defined in ADR-001). Multiple versions per org allowed for rotation.
- **Envelope format:** `[version:1][algorithm:1][keyId:16][iv:12][ciphertext:N][tag:16]`.
- **Hash columns:** **global pepper retained**; per-tenant salt prefix folded into HMAC input — preserves cross-org identity-graph capability (Phase 4) while preventing cross-tenant join via raw hash equality.
- **Migration:** v0 rows continue to decrypt via version byte; new writes are v1; background job converts v0 → v1 lazily.

---

## Reasoning by sub-decision

### 1. KMS provider — AWS KMS (Sydney) behind `KmsClient` interface

Brodie is AU-based. ap-southeast-2 (Sydney) satisfies AU data residency. AWS KMS meets PCI DSS + SOC 2 + ISO 27001 controls that financial-services partners will demand during enterprise sales. GCP KMS is functionally equivalent; pick AWS as the default deployment is more likely AWS-hosted. **No application code couples to AWS** — only one implementation class. Swapping providers = new class registered at bootstrap.

`LocalKmsClient` (dev/test only) uses HKDF-SHA-256 to derive a deterministic 32-byte KEK from `KMS_DEV_SECRET`. No network calls. Conditionally imported only when `NODE_ENV !== 'production'`. Production startup fails if `AWS_KMS_KEY_ARN` is unset.

### 2. DEK granularity — per-Organization

Three options:

| Granularity   | Isolation                                      | KMS API cost  | Ops complexity |
| ------------- | ---------------------------------------------- | ------------- | -------------- |
| Platform-wide | None across tenants                            | Lowest        | Lowest         |
| **Per-org**   | Strong; one disable = whole-tenant cryptoshred | Low (cached)  | Low            |
| Per-table     | No improvement over per-org                    | Low           | Medium         |
| Per-row       | Theoretical maximum                            | $$$ + latency | High           |

Per-org wins decisively. The compelling argument is **org-scale crypto-shredding**: when an Organization is RTBF'd or churned, disabling and scheduling deletion of its DEKs makes all that org's PII permanently unrecoverable in one operation — even from backups (the wrapped DEKs are useless once the KEK is gone).

When per-row isolation becomes warranted (regulated sub-tenant with contractual data segregation), the envelope format already accommodates it: `keyId` encodes which DEK was used per ciphertext. Add per-record DEK rows; route reads via `keyId`.

### 3. Wrapped DEK storage — `tenant_encryption_keys` table

```prisma
model TenantEncryptionKey {
  id         String    @id @db.Uuid           // UUID v7 → 16-byte keyId in envelopes
  orgId      String    @map("org_id") @db.Uuid
  version    Int                                // monotonic per (orgId, purpose); starts at 1
  purpose    String    @default("PII")          // "PII" | "AUDIT" — separate keys per purpose
  wrappedDek Bytes     @map("wrapped_dek")      // KMS-wrapped 32-byte AES key
  kekKeyId   String    @map("kek_key_id")       // AWS KMS key ARN/alias used to wrap
  algorithm  String    @default("AES-256-GCM")  // crypto agility marker
  isActive   Boolean   @default(true) @map("is_active")
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  retiredAt  DateTime? @map("retired_at") @db.Timestamptz(6)

  org Organization @relation(fields: [orgId], references: [id])

  @@unique([orgId, purpose, version])
  @@index([orgId, purpose, isActive])
  @@map("tenant_encryption_keys")
}
```

Multiple versions per (org, purpose) coexist during rotation. `isActive = true` → used for new encrypts. Old versions remain readable until rows are migrated. `retiredAt` set when the final row referencing that version is migrated; only then can the underlying KMS key be deletion-scheduled.

`Organization` model gains `encryptionKeys TenantEncryptionKey[]`.

### 4. Envelope format — `[version:1][algorithm:1][keyId:16][iv:12][ciphertext:N][tag:16]`

Field-by-field:

- `version:1` — governs envelope layout. v0 = `[version][iv][tag][ct]` (legacy, global key). v1 = this layout. Future structural changes increment without breaking decoders.
- `algorithm:1` — crypto agility. `0x01` = AES-256-GCM. ChaCha20-Poly1305 = `0x02`, post-quantum hybrid = `0x03+`. Decoders branch on `(version, algorithm)`.
- `keyId:16` — first 16 bytes of `TenantEncryptionKey.id` (binary UUID). Sufficient to uniquely identify a DEK within any org's history. Saves 20 bytes vs storing the 36-char text UUID — at millions of rows × 3 ciphertext columns this is material.
- `iv:12` — standard 96-bit GCM nonce, random per encryption.
- `ciphertext:N` — variable.
- `tag:16` — GCM auth tag at the end (NIST SP 800-38D canonical position). v0 placed it before ciphertext — implementation choice, not standard. v1 corrects.

Total overhead: **46 bytes** per ciphertext (was 29 in v0).

### 5. Read path — process-local LRU cache for unwrapped DEKs

1. Decoder reads `keyId` (bytes 2-18).
2. `DekCache.get(keyId)` — LRU, max 1000 entries, TTL 1h.
3. Cache miss → load `TenantEncryptionKey` row → `KmsClient.unwrapDataKey(wrappedDek, kekKeyId)` → cache result.
4. AES-256-GCM decrypt with cached DEK + envelope `iv` + verify `tag`.
5. On `INVALID_TAG` → throw `encryption.tampered_ciphertext`. Never silent fallback.

**Eviction on rotation:** Redis pub/sub channel `key:retired:<keyId>` is published when a key is retired; processes subscribe and evict. Avoids process-restart on rotation.

DEKs are held as `Buffer` — Node.js GC collects on eviction. Long-running workers (re-encryption job) call `cache.clear()` on shutdown.

### 6. Hash columns — global pepper + per-tenant salt prefix

HMAC input: `HMAC-SHA256(PII_HASH_SECRET, orgId + ":" + normalize(plaintext))`

Same email across two orgs produces different hashes → no implicit cross-tenant join via SQL `WHERE consumerEmailHash = $1`. Within an org, hashes remain deterministic + indexable.

For Phase 4 identity graph (recognise the same consumer across orgs): hashes are intentionally _not_ comparable across orgs from the database. The identity-resolution layer must decrypt + normalise. **This is the correct trade-off:** identity graph traversal is an explicit, audited operation, not an implicit cross-tenant join.

Trade-off accepted: a single attacker-leaked hash from one org cannot be used to enumerate consumers across other orgs.

### 7. Migration v0 → v1 (no flag day)

**Phase 0 — backward-compat decoder (deploy now):** existing `decryptPII` already version-branches. Add explicit v0 branch using `PII_ENCRYPTION_KEY`. New writes emit v1. No row touched.

**Phase 1 — provision DEKs (one-time script):** for each Organization → `KmsClient.generateDataKey()` → insert `TenantEncryptionKey { version: 1, purpose: 'PII', isActive: true }`. Forward-only DB migration; no `Application` reads.

**Phase 2 — route new writes to v1 (deploy):** `encryptPII` requires `orgId`. Caller supplies from request context. New `Application` inserts use v1.

**Phase 3 — background re-encryption (runs for weeks):** BullMQ `reencrypt-application` job, batches of 100 ordered by `createdAt`. Decrypt v0 → re-encrypt v1 → `prisma.$transaction` write back with optimistic-lock (`updatedAt` check). Rate-limited 500 rows/minute. 1M rows ≈ 33h wall time.

**Phase 4 — retire v0 (gate):** when zero rows remain with version byte 0x00 (v0), remove `PII_ENCRYPTION_KEY` env var and v0 decoder branch. Pre-deploy check enforces.

### 8. Key rotation — zero-downtime

1. `KmsClient.generateDataKey()` → new DEK + wrapped form.
2. `INSERT TenantEncryptionKey { version: current+1, isActive: true }`.
3. `UPDATE prior version SET isActive = false`.
4. `PUBLISH key:rotated:<orgId>` on Redis. Processes update active-key pointer.
5. New writes use `version+1`. Old ciphertexts decrypt via cached DEK lookup keyed on envelope `keyId`.
6. Enqueue `reencrypt-org` BullMQ job for the org.
7. After completion: `retiredAt = now()`. Schedule KMS key deletion with 30-day pending window.

Read latency unaffected — `DekCache` holds both versions until migration completes.

### 9. RTBF interaction — two modes, both supported

**Mode A — row-level cryptoshred (existing, preserved).** Zero ciphertext bytes per row. For targeted erasure of individual consumers within a multi-consumer org. v0 + v1 compatible — zeroed buffer is written regardless of envelope version.

**Mode B — DEK destruction (new, for org-level deletion).** `KmsClient.disableKey()` + `scheduleKeyDeletion()` for every `TenantEncryptionKey` of that org. All ciphertext columns become permanently unrecoverable — including from backups (unwrap requires the KEK, which no longer exists). Strongest possible erasure; satisfies GDPR Art. 17 at org scale.

**Mode B does not replace Mode A** for individual consumer requests. Single-consumer RTBF within an active org always uses Mode A. Mode B is reserved for org-level deletion / churn events.

`RtbfRequest` gains `orgLevel: Boolean @default(false)` — records which mode was applied.

### 10. Audit log encryption — encrypt `metadata` with separate AUDIT-purpose DEK

`AuditLog.metadata` carries plaintext JSON including names (CASE_OPENED), emails (USER_INVITED), customer IDs. A DB dump exposing audit logs is a notifiable breach under AU Privacy Act if PII is present.

Encrypt with a separate-purpose DEK (`purpose = 'AUDIT'`) — independently permissionable. A compliance role can read decrypted audit logs while being denied the PII DEK.

Storage approach: `metadata` JSON gets an `_enc` wrapper key. Old rows are read as-is (no decryption attempted). New rows are written as `{ "_enc": "<base64-envelope>" }`. Read path checks for `_enc` first. No migration job needed — audit is append-only.

### 11. Backup encryption posture

Postgres backups (pg_dump, pgBackRest, RDS automated) contain `tenant_encryption_keys` rows with wrapped DEKs. **Acceptable** — `wrappedDek` is KMS ciphertext; recovering the raw DEK requires live KMS access with valid IAM.

Operational requirements (must be documented + enforced):

- IAM roles with `kms:Decrypt` are NOT attached to backup storage.
- KMS key policies grant `kms:Decrypt` only to API + worker IAM roles.
- RDS automated backups are AES-256 encrypted at rest (separate layer; both active simultaneously).
- Backup restoration is two-step: (a) restore snapshot, (b) ensure restored env has IAM with `kms:Decrypt`. Without (b), restored env has unreadable ciphertext — desired property for stolen backups.

### 12. Local dev — `LocalKmsClient` HKDF derivation

- `generateDataKey()` → 32 random bytes (DEK) + AES-256-GCM-wrap with HKDF-derived KEK.
- `unwrapDataKey()` → unwrap with same KEK.
- `scheduleKeyDeletion()` → no-op + log warning.
- `kekKeyId` in dev is the literal string `"local-dev"`. Never sent externally.

`KMS_DEV_SECRET` env (≥32 chars) added to `.env.example` with note "never use a production value." CI uses a fixed test secret for stable test fixtures.

---

## `KmsClient` interface

```typescript
// apps/api/src/shared/kms/kms-client.interface.ts

export interface GeneratedDataKey {
  /** Raw 32-byte DEK. Memory-only; never persist. */
  plaintext: Buffer;
  /** KMS-encrypted form. Safe to persist in tenant_encryption_keys.wrapped_dek. */
  ciphertext: Buffer;
}

export interface KmsClient {
  generateDataKey(kekKeyId: string): Promise<GeneratedDataKey>;
  wrapDataKey(plaintextDek: Buffer, kekKeyId: string): Promise<Buffer>;
  unwrapDataKey(wrappedDek: Buffer, kekKeyId: string): Promise<Buffer>;
  scheduleKeyDeletion(kekKeyId: string, pendingDays: number): Promise<void>;
  disableKey(kekKeyId: string): Promise<void>;
}
```

---

## Data flow

**Write path (new Application row):**
Request context carries `orgId` → `EncryptionService.encryptForOrg(plaintext, orgId)` → load active `TenantEncryptionKey` for (org, PII) from cache or DB → unwrap DEK if not cached → AES-256-GCM encrypt → emit v1 envelope → store as bytea.

**Read path:**
Read row → version byte:

- `0x00` (zeroed/erased) → return `null`.
- `0x01` (v0 global key) → decrypt via legacy branch with `PII_ENCRYPTION_KEY`.
- `0x02` (v1 per-org DEK) → extract `keyId` → cache lookup → KMS unwrap on miss → AES-256-GCM decrypt.

**RTBF Mode A (row-level):**
HMAC = `orgId + ":" + normalize(email)` → locate Application rows by `consumerEmailHash` within the org → UPDATE: zero all ciphertext columns. Hash columns retained to prevent re-population from same consumer.

**RTBF Mode B (org-level):**
For every `TenantEncryptionKey` of org → `KmsClient.disableKey()` → `scheduleKeyDeletion(7)` → mark `isActive = false` → emit `RtbfRequest { orgLevel: true }` audit row.

---

## Rotation runbook

1. Confirm no in-flight re-encryption job for the org.
2. `POST /platform/orgs/:orgId/rotate-dek` (platform-staff only):
   - `KmsClient.generateDataKey()`.
   - `INSERT TenantEncryptionKey { version: current+1, isActive: true }`.
   - `UPDATE prior SET isActive = false`.
   - `PUBLISH key:rotated:<orgId>` to Redis.
3. Verify new encrypts use new `keyId` (sample a fresh write).
4. Enqueue `reencrypt-org` BullMQ job. Monitor `pii.reencrypt.*.completed` metric.
5. On completion (zero remaining v(n) rows): `retiredAt = now()`.
6. After 30 days: `KmsClient.scheduleKeyDeletion(7)`.
7. After KMS deletion window: confirm KMS status `Deleted`.

---

## Rejected alternatives

**HashiCorp Vault Transit:** Provider-neutral and excellent — but requires running an HA Vault cluster. For a lean AU startup, ops burden outweighs provider-independence benefit at this scale. AWS KMS = managed, no servers. Revisit if/when EazePay becomes genuinely multi-cloud.

**Per-row DEKs:** Theoretical maximum isolation. Rejected on cost (1M rows × KMS calls ≈ $3,000/month at $0.03/10k requests, plus per-read latency). Per-org achieves the operationally important property (whole-tenant cryptoshred) at 1/N the cost.

**Per-table DEKs:** No security improvement vs per-org. Adds DEK provisioning complexity. Rejected.

**Fully global hash columns:** Rejected — creates implicit cross-tenant identity join via SQL `WHERE consumerEmailHash = $1`. Tenant isolation must be a hard property, not a code-discipline property.

**36-char UUID `keyId` in envelope:** Wastes 20 bytes/column × 3 cols × 1M rows = 60 MB. Binary 16-byte UUID sufficient.

---

## Open questions (≤3)

1. **AWS KMS key hierarchy:** Each org's DEK wrapped under one platform-wide CMK, or per-org CMK? Per-org CMKs cost $1/mo/key, enable per-org IAM granularity + per-org CloudTrail audit separation. Platform-wide CMK is simpler/cheaper at low tenant counts. **Recommended: per-org CMKs from day one** — it is much harder to split a platform CMK into per-org later.

2. **RTBF Mode B scope:** Is org-level DEK destruction the right trigger for `Organization` deletion, or should it require an explicit admin action separate from churn? Churned orgs may still hold financial records under regulatory retention — Mode B makes those records permanently unreadable. Need to clarify whether AFS 7-year retention applies to PII columns specifically or only to the financial ledger (no PII).

3. **Audit metadata encryption + existing queries:** The `_enc` wrapper preserves backward compat, but means filtering/searching `metadata` content requires application-layer decryption first. If existing dashboards filter on `metadata` (e.g. surfacing all `USER_INVITED` events for a given email), they will break. Confirm no such queries exist before committing.

---

## Implementation files (when this ADR is executed)

- `apps/api/src/shared/kms/kms-client.interface.ts` — define `KmsClient`, `GeneratedDataKey`
- `apps/api/src/shared/kms/aws-kms-client.ts` — AWS SDK v3 implementation
- `apps/api/src/shared/kms/local-kms-client.ts` — HKDF-based dev implementation
- `apps/api/src/shared/kms/dek-cache.ts` — LRU cache for unwrapped DEKs
- `apps/api/src/shared/utils/encryption.ts` — add v1 encrypt/decrypt branches; `encryptPII` gains `orgId` parameter
- `apps/api/prisma/schema.prisma` — add `TenantEncryptionKey`, update `Organization`, `RtbfRequest`
- `apps/api/src/config/env.ts` — add `AWS_KMS_KEY_ARN`, `KMS_DEV_SECRET`, `AWS_REGION`
- `apps/api/src/domains/rtbf/rtbf.service.ts` — Mode B path
- `apps/api/src/workers/reencrypt.worker.ts` — v0 → v1 background re-encryption
- `apps/api/prisma/migrations/NNNN_envelope_encryption/` — schema migration
