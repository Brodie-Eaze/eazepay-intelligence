/**
 * Unit tests for the v2 envelope encrypt/decrypt round trip.
 *
 * Uses LocalKmsClient (HKDF-derived KEK) to avoid network/AWS dependencies.
 * Mocks Prisma at the call sites to isolate the cryptographic layer from
 * the DB layer.
 */
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  ENVELOPE_VERSION_V2,
  ALGORITHM_AES_256_GCM,
  decryptEnvelopeAuto,
  decryptEnvelopeV2,
  encryptForOrg,
  setKmsClient,
  __resetKmsClientForTests,
} from '../../src/shared/kms/tenant-dek.js';
import { LocalKmsClient } from '../../src/shared/kms/local-kms-client.js';
import { __resetDekCacheForTests } from '../../src/shared/kms/dek-cache.js';

beforeAll(() => {
  process.env.KMS_DEV_SECRET = 'a'.repeat(32);
});

beforeEach(() => {
  __resetKmsClientForTests();
  __resetDekCacheForTests();
  setKmsClient(new LocalKmsClient());
});

// Build a fake Prisma client surface — only the methods the v2 envelope code
// actually calls. Avoids spinning up a real connection or relying on schema.
function buildStubPrisma(initialKey?: {
  id: string;
  orgId: string;
  purpose: string;
  wrappedDek: Buffer;
  kekKeyId: string;
}): {
  prisma: any;
  rows: Array<typeof initialKey & { isActive: boolean }>;
} {
  const rows: Array<NonNullable<typeof initialKey> & { isActive: boolean }> = initialKey
    ? [{ ...initialKey, isActive: true }]
    : [];
  const prisma = {
    tenantEncryptionKey: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return (
          rows.find(
            (r) => r.orgId === w.orgId && r.purpose === w.purpose && r.isActive === w.isActive,
          ) ?? null
        );
      },
      findUnique: async (args: { where: { id: string } }) => {
        return rows.find((r) => r.id === args.where.id) ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { ...(args.data as any), isActive: true };
        rows.push(row);
        return row;
      },
    },
  };
  return { prisma, rows };
}

describe('encryptForOrg + decryptEnvelopeV2 round trip', () => {
  it('encrypts and decrypts a string round-trip when DEK exists', async () => {
    const orgId = uuidv7();
    const keyId = uuidv7();
    const generated = await new LocalKmsClient().generateDataKey('local-dev');
    const { prisma } = buildStubPrisma({
      id: keyId,
      orgId,
      purpose: 'PII',
      wrappedDek: generated.ciphertext,
      kekKeyId: 'local-dev',
    });

    const plaintext = 'sensitive consumer email <user@example.com>';
    const envelope = await encryptForOrg(prisma, plaintext, orgId);

    expect(envelope[0]).toBe(ENVELOPE_VERSION_V2);
    expect(envelope[1]).toBe(ALGORITHM_AES_256_GCM);
    // Header layout: [version:1][algo:1][keyId:16][iv:12][ct:N][tag:16]
    expect(envelope.length).toBeGreaterThanOrEqual(46);

    const decrypted = await decryptEnvelopeV2(prisma, envelope);
    expect(decrypted).toBe(plaintext);
  });

  it('embeds the keyId of the active DEK in the envelope', async () => {
    const orgId = uuidv7();
    const keyId = uuidv7();
    const generated = await new LocalKmsClient().generateDataKey('local-dev');
    const { prisma } = buildStubPrisma({
      id: keyId,
      orgId,
      purpose: 'PII',
      wrappedDek: generated.ciphertext,
      kekKeyId: 'local-dev',
    });

    const envelope = await encryptForOrg(prisma, 'x', orgId);
    const keyIdHex = envelope.subarray(2, 18).toString('hex');
    const keyIdReconstructed =
      `${keyIdHex.slice(0, 8)}-${keyIdHex.slice(8, 12)}-${keyIdHex.slice(12, 16)}-` +
      `${keyIdHex.slice(16, 20)}-${keyIdHex.slice(20, 32)}`;
    expect(keyIdReconstructed).toBe(keyId);
  });

  it('different orgs produce mutually-undecryptable ciphertext', async () => {
    const orgA = uuidv7();
    const orgB = uuidv7();
    const keyA = uuidv7();
    const keyB = uuidv7();
    const kms = new LocalKmsClient();
    const dekA = await kms.generateDataKey('local-dev');
    const dekB = await kms.generateDataKey('local-dev');

    const rows = [
      {
        id: keyA,
        orgId: orgA,
        purpose: 'PII',
        wrappedDek: dekA.ciphertext,
        kekKeyId: 'local-dev',
        isActive: true,
      },
      {
        id: keyB,
        orgId: orgB,
        purpose: 'PII',
        wrappedDek: dekB.ciphertext,
        kekKeyId: 'local-dev',
        isActive: true,
      },
    ];
    const prisma: any = {
      tenantEncryptionKey: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const w = args.where;
          return (
            rows.find((r) => r.orgId === w.orgId && r.purpose === w.purpose && r.isActive) ?? null
          );
        },
        findUnique: async (args: { where: { id: string } }) =>
          rows.find((r) => r.id === args.where.id) ?? null,
        create: async () => null,
      },
    };

    const ctA = await encryptForOrg(prisma, 'org A secret', orgA);
    // Tamper: swap the keyId bytes in ctA to point to org B's key. The DEK
    // is wrong → GCM auth tag fails → decryption throws.
    const tamperedKeyHex = keyB.replace(/-/g, '');
    const tamperedKeyBytes = Buffer.from(tamperedKeyHex, 'hex');
    const tamperedEnvelope = Buffer.concat([
      ctA.subarray(0, 2),
      tamperedKeyBytes,
      ctA.subarray(18),
    ]);
    await expect(decryptEnvelopeV2(prisma, tamperedEnvelope)).rejects.toThrow();
  });

  it('throws when envelope is shorter than the minimum header', async () => {
    const { prisma } = buildStubPrisma();
    await expect(decryptEnvelopeV2(prisma, Buffer.alloc(10))).rejects.toThrow(/too short/);
  });

  it('throws on unsupported algorithm byte', async () => {
    const { prisma } = buildStubPrisma();
    const bad = Buffer.alloc(46);
    bad[0] = ENVELOPE_VERSION_V2;
    bad[1] = 0x99; // unsupported
    await expect(decryptEnvelopeV2(prisma, bad)).rejects.toThrow(/unsupported algorithm/);
  });
});

describe('decryptEnvelopeAuto', () => {
  it('routes v2 envelope to the v2 decoder', async () => {
    const orgId = uuidv7();
    const keyId = uuidv7();
    const generated = await new LocalKmsClient().generateDataKey('local-dev');
    const { prisma } = buildStubPrisma({
      id: keyId,
      orgId,
      purpose: 'PII',
      wrappedDek: generated.ciphertext,
      kekKeyId: 'local-dev',
    });
    const v2 = await encryptForOrg(prisma, 'hello v2', orgId);
    const decrypted = await decryptEnvelopeAuto(prisma, v2, () => {
      throw new Error('legacy decoder should not be called for v2');
    });
    expect(decrypted).toBe('hello v2');
  });

  it('routes v1 envelope to the legacy decoder', async () => {
    const { prisma } = buildStubPrisma();
    const v1 = Buffer.alloc(50);
    v1[0] = 0x01;
    let legacyCalled = false;
    const decrypted = await decryptEnvelopeAuto(prisma, v1, (env) => {
      legacyCalled = true;
      expect(env[0]).toBe(0x01);
      return 'hello v1';
    });
    expect(legacyCalled).toBe(true);
    expect(decrypted).toBe('hello v1');
  });
});
