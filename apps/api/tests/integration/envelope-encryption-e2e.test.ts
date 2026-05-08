/**
 * Envelope encryption — end-to-end against the real local DB.
 *
 * Proves the whole DEK + envelope-v2 stack works on actual Prisma rows:
 *
 *   1. Create two test orgs.
 *   2. Provision a PII DEK for each via ensureActiveDek (LocalKmsClient).
 *   3. Encrypt a string under org A → store ciphertext in
 *      `tenant_encryption_keys.wrapped_dek` round-trip via decryptEnvelopeV2.
 *   4. Confirm org A's ciphertext cannot be decrypted using org B's DEK
 *      (the envelope embeds the keyId, so decrypt looks up the right DEK
 *      automatically — but if we tamper the keyId to point to B's DEK, the
 *      AES-GCM auth tag mismatch causes the decrypt to throw).
 *   5. Rotate org A's DEK; confirm both old and new ciphertext decrypt
 *      (old via the deactivated row, new via the active row).
 *   6. Tear down everything.
 *
 * Skipped if DATABASE_URL isn't resolvable (CI without DB). Live test —
 * touches real Postgres. Cleans up its fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { LocalKmsClient } from '../../src/shared/kms/local-kms-client.js';
import {
  decryptEnvelopeV2,
  encryptForOrg,
  ensureActiveDek,
  rotateDek,
  setKmsClient,
  __resetKmsClientForTests,
} from '../../src/shared/kms/tenant-dek.js';
import { __resetDekCacheForTests } from '../../src/shared/kms/dek-cache.js';

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = pathResolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return '';
  const text = readFileSync(envPath, 'utf8');
  const match = text.match(/^DATABASE_URL=(.+)$/m);
  return match?.[1]?.trim() ?? '';
}

const PRIMARY_URL = resolveDatabaseUrl();
const SUITE_ENABLED = Boolean(PRIMARY_URL);

describe.skipIf(!SUITE_ENABLED)('envelope encryption — end-to-end', () => {
  let prisma: PrismaClient;
  const orgA = uuidv7();
  const orgB = uuidv7();
  const cleanupOrgIds = [orgA, orgB];

  beforeAll(async () => {
    process.env.KMS_DEV_SECRET = process.env.KMS_DEV_SECRET ?? 'b'.repeat(32);
    __resetKmsClientForTests();
    __resetDekCacheForTests();
    setKmsClient(new LocalKmsClient());
    prisma = new PrismaClient({ datasources: { db: { url: PRIMARY_URL } } });
    const stamp = Date.now().toString(36);
    await prisma.organization.create({
      data: { id: orgA, slug: `e2e-enc-a-${stamp}`, name: 'E2E Enc A' },
    });
    await prisma.organization.create({
      data: { id: orgB, slug: `e2e-enc-b-${stamp}`, name: 'E2E Enc B' },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.tenantEncryptionKey.deleteMany({ where: { orgId: { in: cleanupOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
    await prisma.$disconnect();
  });

  it('provisions a PII DEK for each org and persists the wrapped form', async () => {
    const a = await ensureActiveDek(prisma, orgA);
    const b = await ensureActiveDek(prisma, orgB);
    expect(a.orgId).toBe(orgA);
    expect(b.orgId).toBe(orgB);

    // Verify the wrapped_dek column actually contains bytes (not the
    // plaintext we generated locally).
    const rowA = await prisma.tenantEncryptionKey.findUnique({ where: { id: a.id } });
    expect(rowA?.wrappedDek.length).toBeGreaterThan(0);
    expect(rowA?.algorithm).toBe('AES-256-GCM');
    expect(rowA?.isActive).toBe(true);
  });

  it('round-trips a plaintext through encrypt → DB-aware decrypt', async () => {
    const plaintext = 'consumer email: user@example.com';
    const envelope = await encryptForOrg(prisma, plaintext, orgA);
    const decrypted = await decryptEnvelopeV2(prisma, envelope);
    expect(decrypted).toBe(plaintext);
  });

  it('cross-org tampering: forcing org A ciphertext through org B DEK fails GCM auth', async () => {
    const a = await prisma.tenantEncryptionKey.findFirstOrThrow({
      where: { orgId: orgA, purpose: 'PII', isActive: true },
    });
    const b = await prisma.tenantEncryptionKey.findFirstOrThrow({
      where: { orgId: orgB, purpose: 'PII', isActive: true },
    });
    const envelope = await encryptForOrg(prisma, 'org A secret', orgA);
    // Sanity: original keyId in envelope is org A's.
    const keyIdHex = envelope.subarray(2, 18).toString('hex');
    const expectedAHex = a.id.replace(/-/g, '');
    expect(keyIdHex).toBe(expectedAHex);

    // Tamper: replace org A keyId bytes with org B's. AES-GCM auth tag now
    // computed under DEK A but verified against DEK B → mismatch → throw.
    const bHex = b.id.replace(/-/g, '');
    const tampered = Buffer.concat([
      envelope.subarray(0, 2),
      Buffer.from(bHex, 'hex'),
      envelope.subarray(18),
    ]);
    await expect(decryptEnvelopeV2(prisma, tampered)).rejects.toThrow();
  });

  it('rotate-then-decrypt: old ciphertext still decryptable via the deactivated DEK row', async () => {
    // Encrypt under v1, rotate, encrypt under v2, decrypt both.
    const oldEnvelope = await encryptForOrg(prisma, 'legacy v1 plaintext', orgA);
    const rotated = await rotateDek(prisma, orgA, { purpose: 'PII' });
    expect(rotated.version).toBeGreaterThanOrEqual(2);
    const newEnvelope = await encryptForOrg(prisma, 'fresh v2 plaintext', orgA);

    // The two envelopes should embed different keyIds.
    const oldKeyHex = oldEnvelope.subarray(2, 18).toString('hex');
    const newKeyHex = newEnvelope.subarray(2, 18).toString('hex');
    expect(oldKeyHex).not.toBe(newKeyHex);

    // Both decrypt — old via the deactivated (still-readable) row, new via active.
    expect(await decryptEnvelopeV2(prisma, oldEnvelope)).toBe('legacy v1 plaintext');
    expect(await decryptEnvelopeV2(prisma, newEnvelope)).toBe('fresh v2 plaintext');
  });
});
