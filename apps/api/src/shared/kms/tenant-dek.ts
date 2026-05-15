/**
 * Per-tenant DEK provisioning + envelope encrypt/decrypt.
 *
 * This is the runtime crypto layer that pairs with `tenant_encryption_keys`
 * in the DB and a `KmsClient` (LocalKmsClient in dev, AwsKmsClient in prod).
 *
 * Two envelope formats coexist on the read path:
 *
 *   v1 (legacy, byte 0x01) — global PII_ENCRYPTION_KEY
 *      [version:1][iv:12][tag:16][ct:N]
 *      Decoded by the existing `decryptPII()` in shared/utils/encryption.ts.
 *
 *   v2 (per-tenant, byte 0x02) — per-org DEK wrapped under per-org KEK
 *      [version:1][algorithm:1][keyId:16][iv:12][ct:N][tag:16]
 *      Decoded by `decryptEnvelopeV2()` here.
 *
 * Write path: new code uses `encryptForOrg(plaintext, orgId)` which emits
 * v2. The legacy `encryptPII()` continues to emit v1 during the migration
 * window. A background re-encryption worker (Phase 1.5 expansion) converts
 * v1 → v2 lazily; that worker is NOT included in this module.
 *
 * KMS abstraction is registered at process bootstrap via `setKmsClient()`.
 * In tests + dev, register a `LocalKmsClient`. In prod, register the
 * AWS KMS implementation (Phase 1.5 expansion).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import { getDekCache } from './dek-cache.js';
import type { KmsClient } from './kms-client.interface.js';
import { LOCAL_DEV_KEY_ID } from './local-kms-client.js';

// ─── Envelope format constants ──────────────────────────────────────────────

export const ENVELOPE_VERSION_V2 = 0x02;
export const ALGORITHM_AES_256_GCM = 0x01;

const VERSION_LEN = 1;
const ALGO_LEN = 1;
const KEY_ID_LEN = 16; // first 16 bytes of TenantEncryptionKey.id (binary UUID)
const IV_LEN = 12;
const TAG_LEN = 16;

const V2_HEADER_LEN = VERSION_LEN + ALGO_LEN + KEY_ID_LEN + IV_LEN; // 30 bytes
const V2_MIN_LEN = V2_HEADER_LEN + TAG_LEN; // 46 bytes (zero-byte ciphertext)

// ─── KMS client registration ────────────────────────────────────────────────

let registered: KmsClient | undefined;

export function setKmsClient(client: KmsClient): void {
  registered = client;
}

export function getKmsClient(): KmsClient {
  if (!registered) {
    throw new Error('tenant-dek: no KmsClient registered. Call setKmsClient() at bootstrap.');
  }
  return registered;
}

export function __resetKmsClientForTests(): void {
  registered = undefined;
}

// ─── Provisioning ───────────────────────────────────────────────────────────

interface ProvisionOptions {
  /**
   * KMS Key Encryption Key identifier. Production: AWS KMS key ARN.
   * Dev: omit to use the literal `'local-dev'`.
   */
  kekKeyId?: string;
  /** 'PII' | 'AUDIT'. Default 'PII'. */
  purpose?: 'PII' | 'AUDIT';
}

/**
 * Ensure the org has an active DEK for the given purpose. Idempotent — if
 * one already exists, returns it. Otherwise calls KMS to generate, persists
 * the wrapped form, and returns the row.
 *
 * Used by:
 *   - seed scripts (one-time DEK provisioning per existing org)
 *   - the rotation runbook (creates version+1, deactivates version)
 *   - org creation handler (Phase 1.6 — `POST /platform/orgs`)
 */
export async function ensureActiveDek(
  prisma: PrismaClient,
  orgId: string,
  opts: ProvisionOptions = {},
): Promise<{ id: string; version: number; orgId: string; purpose: string }> {
  const purpose = opts.purpose ?? 'PII';
  const kekKeyId = opts.kekKeyId ?? LOCAL_DEV_KEY_ID;

  const existing = await prisma.tenantEncryptionKey.findFirst({
    where: { orgId, purpose, isActive: true },
    select: { id: true, version: true, orgId: true, purpose: true },
  });
  if (existing) return existing;

  const kms = getKmsClient();
  const generated = await kms.generateDataKey(kekKeyId);

  // First version per (org, purpose) is 1; subsequent rotations call
  // `rotateDek` which increments. ensureActiveDek is the idempotent
  // first-provisioning path.
  const created = await prisma.tenantEncryptionKey.create({
    data: {
      id: uuidv7(),
      orgId,
      version: 1,
      purpose,
      wrappedDek: generated.ciphertext,
      kekKeyId,
      algorithm: 'AES-256-GCM',
      isActive: true,
    },
    select: { id: true, version: true, orgId: true, purpose: true },
  });

  // Pre-warm the cache with the plaintext we just got — saves an unwrap
  // round-trip on the first encrypt.
  getDekCache().set(created.id, generated.plaintext);

  return created;
}

/**
 * Rotate the active DEK for an org+purpose. Per ADR-002 §8:
 *   1. Generate a fresh DEK via KMS.
 *   2. Insert a new TenantEncryptionKey row with version+1, isActive=true.
 *   3. Mark the prior version isActive=false (still readable until
 *      background re-encryption converts old ciphertext to the new key).
 *
 * Returns the NEW DEK row. The old DEK remains readable from
 * `tenant_encryption_keys` so existing ciphertext keeps decrypting; only
 * the active-key pointer for new encrypts has moved.
 *
 * THIS DOES NOT trigger background re-encryption. The rotation runbook
 * is: rotate → enqueue re-encryption job → wait for completion → set
 * old version's retiredAt → schedule KMS deletion. Only the rotate step
 * is here; the rest lives in the platform routes / worker.
 */
export async function rotateDek(
  prisma: PrismaClient,
  orgId: string,
  opts: ProvisionOptions = {},
): Promise<{ id: string; version: number; orgId: string; purpose: string }> {
  const purpose = opts.purpose ?? 'PII';
  const kekKeyId = opts.kekKeyId ?? LOCAL_DEV_KEY_ID;

  return prisma.$transaction(async (tx) => {
    // Find the current highest version for (orgId, purpose). Don't filter
    // by isActive — we want the absolute latest version number even if
    // the active row was somehow deleted, to avoid version collisions.
    const latest = await tx.tenantEncryptionKey.findFirst({
      where: { orgId, purpose },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, isActive: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    // KMS call happens INSIDE the tx — if Postgres rolls back we don't
    // want a stranded wrapped key in tenant_encryption_keys. The KMS
    // operation itself is not transactional (a wrapped DEK exists in
    // the ether) but with no DB row referencing it, it's effectively
    // unreachable.
    const kms = getKmsClient();
    const generated = await kms.generateDataKey(kekKeyId);

    const created = await tx.tenantEncryptionKey.create({
      data: {
        id: uuidv7(),
        orgId,
        version: nextVersion,
        purpose,
        wrappedDek: generated.ciphertext,
        kekKeyId,
        algorithm: 'AES-256-GCM',
        isActive: true,
      },
      select: { id: true, version: true, orgId: true, purpose: true },
    });

    // Deactivate every prior version for this (org, purpose). Keeps the
    // old DEKs readable (rows still exist) but no new encrypts route to
    // them. retiredAt remains null until background re-encryption finishes.
    if (latest) {
      await tx.tenantEncryptionKey.updateMany({
        where: { orgId, purpose, isActive: true, NOT: { id: created.id } },
        data: { isActive: false },
      });
    }

    // Pre-warm the cache with the new plaintext so the next encrypt
    // doesn't pay the KMS unwrap round-trip.
    getDekCache().set(created.id, generated.plaintext);
    return created;
  });
}

/**
 * Look up the active DEK row for an org+purpose without provisioning.
 * Throws if missing — callers must run `ensureActiveDek` first or
 * accept the error.
 */
export async function loadActiveDekRow(
  prisma: PrismaClient,
  orgId: string,
  purpose: 'PII' | 'AUDIT' = 'PII',
): Promise<{ id: string; wrappedDek: Buffer; kekKeyId: string }> {
  const row = await prisma.tenantEncryptionKey.findFirst({
    where: { orgId, purpose, isActive: true },
    select: { id: true, wrappedDek: true, kekKeyId: true },
  });
  if (!row) {
    throw new Error(
      `tenant-dek: no active DEK for orgId=${orgId} purpose=${purpose}. Call ensureActiveDek first.`,
    );
  }
  return row;
}

/**
 * Resolve the plaintext DEK for a given key id, fetching from cache or
 * unwrapping via KMS on miss. Caller-side hot path on every encrypt + decrypt.
 */
export async function resolveDekPlaintext(prisma: PrismaClient, keyId: string): Promise<Buffer> {
  const cached = getDekCache().get(keyId);
  if (cached) return cached;
  const row = await prisma.tenantEncryptionKey.findUnique({
    where: { id: keyId },
    select: { wrappedDek: true, kekKeyId: true },
  });
  if (!row) throw new Error(`tenant-dek: keyId ${keyId} not found`);
  const plaintext = await getKmsClient().unwrapDataKey(row.wrappedDek, row.kekKeyId);
  getDekCache().set(keyId, plaintext);
  return plaintext;
}

// ─── RTBF Mode B — org-level cryptoshred ───────────────────────────────────

export interface CryptoshredOrgResult {
  /** Number of DEK rows acted on (covers PII + AUDIT + any other purposes). */
  dekCount: number;
  /** KMS keys we successfully scheduled for deletion. */
  kmsKeysScheduledForDeletion: string[];
  /** Per-DEK errors keyed by KMS keyId. The DB rows are still deactivated. */
  errors: Array<{ kekKeyId: string; message: string }>;
}

/**
 * Cryptoshred an entire organisation's PII per ADR-002 §9 Mode B.
 *
 * What this does:
 *   1. For every TenantEncryptionKey row owned by the org (across ALL
 *      purposes — PII, AUDIT, future):
 *        a. Mark the DB row isActive=false + retiredAt=now.
 *        b. Call KmsClient.disableKey(kekKeyId) — immediate unreadability.
 *        c. Call KmsClient.scheduleKeyDeletion(kekKeyId, pendingDays).
 *   2. Evict all matching keyIds from the in-process DekCache so no
 *      cached plaintext lingers.
 *
 * The org row itself is NOT deleted here — audit logs reference it. The
 * caller (typically the cryptoshred endpoint) is responsible for the
 * surrounding workflow:
 *   - confirm authorisation (SUPER + double-confirm header)
 *   - revoke active sessions
 *   - write the audit row
 *   - optionally soft-delete the org row + memberships
 *
 * Effect on existing ciphertext:
 *   Once `pendingDays` elapses, the KMS keys are destroyed. All
 *   `wrapped_dek` BYTEAs in the DB become permanently unrecoverable.
 *   Application PII columns encrypted under those DEKs are then
 *   provably unreadable — including from any database backup. This is
 *   the strongest possible erasure guarantee under GDPR Art. 17 +
 *   APP 11.
 *
 * IRREVERSIBILITY:
 *   Within `pendingDays` an admin can call `kms:CancelKeyDeletion` to
 *   recover. After the window elapses, recovery is impossible. The
 *   default 7-day window matches AWS KMS's minimum.
 *
 * @param prisma       PrismaClient (the writer; this writes to
 *                     tenant_encryption_keys).
 * @param orgId        Organisation to cryptoshred.
 * @param pendingDays  KMS pending-deletion window. AWS KMS accepts 7..30.
 *                     LocalKmsClient no-ops the deletion regardless.
 *                     Default 7 (minimum, fastest erasure).
 *
 * @returns CryptoshredOrgResult — the caller decides whether any errors
 *          warrant an alert. The DB rows are deactivated even if the KMS
 *          calls partially fail; the caller may retry the KMS calls
 *          independently against the deactivated rows.
 */
export async function cryptoshredOrg(
  prisma: PrismaClient,
  orgId: string,
  pendingDays = 7,
): Promise<CryptoshredOrgResult> {
  const kms = getKmsClient();
  const cache = getDekCache();

  const allKeys = await prisma.tenantEncryptionKey.findMany({
    where: { orgId },
    select: { id: true, kekKeyId: true, isActive: true },
  });

  const result: CryptoshredOrgResult = {
    dekCount: allKeys.length,
    kmsKeysScheduledForDeletion: [],
    errors: [],
  };

  // Deactivate DB rows in one update — fast, atomic.
  await prisma.tenantEncryptionKey.updateMany({
    where: { orgId, isActive: true },
    data: { isActive: false, retiredAt: new Date() },
  });

  // Evict cached plaintext DEKs so even an in-flight encrypt observes the
  // deactivation immediately.
  for (const k of allKeys) cache.evict(k.id);

  // Per-key KMS operations. Disable first (immediate unreadability), then
  // schedule deletion (durable destruction). Best-effort — record errors
  // and continue; the DB-level deactivation already prevents new encrypts.
  // De-duplicate kekKeyId because multiple DEKs (versions) may share one
  // CMK in the platform-wide-CMK strategy.
  const seenKeks = new Set<string>();
  for (const k of allKeys) {
    if (seenKeks.has(k.kekKeyId)) continue;
    seenKeks.add(k.kekKeyId);
    try {
      await kms.disableKey(k.kekKeyId);
    } catch (err) {
      result.errors.push({
        kekKeyId: k.kekKeyId,
        message: `disableKey failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Continue to scheduleKeyDeletion — it can succeed even when the
      // disable already failed (key in another state, IAM mismatch, etc).
    }
    try {
      await kms.scheduleKeyDeletion(k.kekKeyId, pendingDays);
      result.kmsKeysScheduledForDeletion.push(k.kekKeyId);
    } catch (err) {
      result.errors.push({
        kekKeyId: k.kekKeyId,
        message: `scheduleKeyDeletion failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}

// ─── Envelope v2 encode/decode ──────────────────────────────────────────────

/**
 * Encrypt `plaintext` for `orgId` using the active DEK. Emits a v2 envelope.
 *
 * The DEK is loaded once per cache lifetime (1h) and held in memory; this
 * function does NOT call KMS on every encrypt. Cold start: ~one KMS round
 * trip per (org, purpose) per process startup.
 */
export async function encryptForOrg(
  prisma: PrismaClient,
  plaintext: string,
  orgId: string,
  purpose: 'PII' | 'AUDIT' = 'PII',
): Promise<Buffer> {
  const row = await loadActiveDekRow(prisma, orgId, purpose);
  const dek = await resolveDekPlaintext(prisma, row.id);

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // First 16 bytes of the UUID v7 (binary). We encode the keyId by parsing
  // the hyphenated UUID string and stripping hyphens to get hex, then
  // converting to a 16-byte Buffer. uuid library has no helper for this;
  // doing it inline is ~6 lines and avoids a new dep.
  const keyIdHex = row.id.replace(/-/g, '');
  const keyIdBytes = Buffer.from(keyIdHex, 'hex');
  if (keyIdBytes.length !== KEY_ID_LEN) {
    throw new Error(
      `tenant-dek: keyId encoding produced ${keyIdBytes.length} bytes, expected ${KEY_ID_LEN}`,
    );
  }

  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION_V2, ALGORITHM_AES_256_GCM]),
    keyIdBytes,
    iv,
    ct,
    tag,
  ]);
}

/**
 * Decode a v2 envelope. Caller must have previously verified the version
 * byte (the legacy `decryptPII` in shared/utils/encryption.ts dispatches
 * on byte 0).
 */
export async function decryptEnvelopeV2(prisma: PrismaClient, envelope: Buffer): Promise<string> {
  if (envelope.length < V2_MIN_LEN) {
    throw new Error('tenant-dek: envelope too short for v2');
  }
  const version = envelope.readUInt8(0);
  if (version !== ENVELOPE_VERSION_V2) {
    throw new Error(`tenant-dek: expected v2 envelope, got version ${version}`);
  }
  const algorithm = envelope.readUInt8(1);
  if (algorithm !== ALGORITHM_AES_256_GCM) {
    throw new Error(`tenant-dek: unsupported algorithm ${algorithm}`);
  }

  const keyIdBytes = envelope.subarray(2, 2 + KEY_ID_LEN);
  const keyIdHex = keyIdBytes.toString('hex');
  // Re-format hex back to UUID v4/v7 canonical form for the DB lookup.
  const keyId =
    `${keyIdHex.slice(0, 8)}-${keyIdHex.slice(8, 12)}-${keyIdHex.slice(12, 16)}-` +
    `${keyIdHex.slice(16, 20)}-${keyIdHex.slice(20, 32)}`;

  const dek = await resolveDekPlaintext(prisma, keyId);

  const ivStart = V2_HEADER_LEN - IV_LEN;
  const iv = envelope.subarray(ivStart, V2_HEADER_LEN);
  const ct = envelope.subarray(V2_HEADER_LEN, envelope.length - TAG_LEN);
  const tag = envelope.subarray(envelope.length - TAG_LEN);

  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

/**
 * Read-path dispatcher: detects envelope version and routes to the right
 * decoder. v1 (0x01) goes through the legacy global-key path; v2 (0x02)
 * goes through `decryptEnvelopeV2` here.
 *
 * Callers that have access to a Prisma client should use this dispatcher
 * rather than dispatching themselves. Existing call sites that only call
 * `decryptPII()` continue to work for v1 ciphertext; they must migrate to
 * this dispatcher to handle v2 ciphertext.
 */
export async function decryptEnvelopeAuto(
  prisma: PrismaClient,
  envelope: Buffer,
  legacyDecrypt: (env: Buffer) => string,
): Promise<string> {
  if (envelope.length === 0) throw new Error('tenant-dek: empty envelope');
  const version = envelope.readUInt8(0);
  if (version === ENVELOPE_VERSION_V2) {
    return decryptEnvelopeV2(prisma, envelope);
  }
  // v1 (0x01) and any future legacy versions handled by the global-key path.
  return legacyDecrypt(envelope);
}
