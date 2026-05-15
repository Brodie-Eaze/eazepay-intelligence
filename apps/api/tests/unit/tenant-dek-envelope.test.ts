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
  rotateDek,
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

describe('rotateDek', () => {
  // The rotate flow uses prisma.$transaction. We need a richer stub that
  // returns a tx client with the same nested method shape.
  function buildTxStubPrisma(
    rows: Array<{
      id: string;
      orgId: string;
      purpose: string;
      version: number;
      wrappedDek: Buffer;
      kekKeyId: string;
      isActive: boolean;
    }>,
  ): any {
    const txMethods = {
      tenantEncryptionKey: {
        findFirst: async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
          const w = args.where;
          const matches = rows.filter((r) => r.orgId === w.orgId && r.purpose === w.purpose);
          if (matches.length === 0) return null;
          // version desc — take the highest version row
          matches.sort((a, b) => b.version - a.version);
          return matches[0];
        },
        findUnique: async (args: { where: { id: string } }) =>
          rows.find((r) => r.id === args.where.id) ?? null,
        create: async (args: { data: Record<string, unknown> }) => {
          const row = { ...(args.data as any) };
          rows.push(row);
          return row;
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const r of rows) {
            const w = args.where;
            const notId = (w.NOT as { id: string } | undefined)?.id;
            if (
              r.orgId === w.orgId &&
              r.purpose === w.purpose &&
              r.isActive === w.isActive &&
              r.id !== notId
            ) {
              Object.assign(r, args.data);
              count += 1;
            }
          }
          return { count };
        },
      },
    };
    return {
      ...txMethods,
      $transaction: async <T>(fn: (tx: typeof txMethods) => Promise<T>): Promise<T> =>
        fn(txMethods),
    };
  }

  it('inserts a new active DEK with version+1 and deactivates the prior', async () => {
    const orgId = uuidv7();
    const oldKeyId = uuidv7();
    const oldDek = await new LocalKmsClient().generateDataKey('local-dev');
    const rows: any[] = [
      {
        id: oldKeyId,
        orgId,
        purpose: 'PII',
        version: 1,
        wrappedDek: oldDek.ciphertext,
        kekKeyId: 'local-dev',
        isActive: true,
      },
    ];
    const prisma = buildTxStubPrisma(rows);

    const result = await rotateDek(prisma, orgId, { purpose: 'PII' });

    expect(result.version).toBe(2);
    expect(result.orgId).toBe(orgId);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.id === oldKeyId);
    expect(oldRow?.isActive).toBe(false);
    const newRow = rows.find((r) => r.id === result.id);
    expect(newRow?.isActive).toBe(true);
  });

  it('starts at version 1 when no prior DEK exists', async () => {
    const orgId = uuidv7();
    const rows: any[] = [];
    const prisma = buildTxStubPrisma(rows);

    const result = await rotateDek(prisma, orgId);
    expect(result.version).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('rotation only affects the (org, purpose) being rotated', async () => {
    const orgId = uuidv7();
    const piiKey = uuidv7();
    const auditKey = uuidv7();
    const piiDek = await new LocalKmsClient().generateDataKey('local-dev');
    const auditDek = await new LocalKmsClient().generateDataKey('local-dev');
    const rows: any[] = [
      {
        id: piiKey,
        orgId,
        purpose: 'PII',
        version: 1,
        wrappedDek: piiDek.ciphertext,
        kekKeyId: 'local-dev',
        isActive: true,
      },
      {
        id: auditKey,
        orgId,
        purpose: 'AUDIT',
        version: 1,
        wrappedDek: auditDek.ciphertext,
        kekKeyId: 'local-dev',
        isActive: true,
      },
    ];
    const prisma = buildTxStubPrisma(rows);

    await rotateDek(prisma, orgId, { purpose: 'PII' });

    const auditRow = rows.find((r) => r.id === auditKey);
    expect(auditRow?.isActive).toBe(true); // AUDIT untouched
    const piiOldRow = rows.find((r) => r.id === piiKey);
    expect(piiOldRow?.isActive).toBe(false);
  });
});

describe('cryptoshredOrg', () => {
  function buildShredStubPrisma(
    rows: Array<{
      id: string;
      orgId: string;
      purpose: string;
      kekKeyId: string;
      isActive: boolean;
      retiredAt: Date | null;
    }>,
  ): { prisma: any; updateManyCalls: number } {
    let updateManyCalls = 0;
    const prisma: any = {
      tenantEncryptionKey: {
        findMany: async (args: { where: { orgId: string } }) =>
          rows.filter((r) => r.orgId === args.where.orgId),
        updateMany: async (args: {
          where: { orgId: string; isActive?: boolean };
          data: { isActive?: boolean; retiredAt?: Date };
        }) => {
          updateManyCalls += 1;
          let count = 0;
          for (const r of rows) {
            if (
              r.orgId === args.where.orgId &&
              (args.where.isActive === undefined || r.isActive === args.where.isActive)
            ) {
              if (args.data.isActive !== undefined) r.isActive = args.data.isActive;
              if (args.data.retiredAt !== undefined) r.retiredAt = args.data.retiredAt;
              count += 1;
            }
          }
          return { count };
        },
      },
    };
    return { prisma, updateManyCalls };
  }

  // Tracking KMS calls — wrap LocalKmsClient to record disable/delete
  function trackingKms() {
    const disabled: string[] = [];
    const scheduled: Array<{ kekKeyId: string; pendingDays: number }> = [];
    setKmsClient({
      generateDataKey: () => Promise.reject(new Error('not used')),
      wrapDataKey: () => Promise.reject(new Error('not used')),
      unwrapDataKey: () => Promise.reject(new Error('not used')),
      disableKey: async (k) => {
        disabled.push(k);
      },
      scheduleKeyDeletion: async (k, d) => {
        scheduled.push({ kekKeyId: k, pendingDays: d });
      },
    });
    return { disabled, scheduled };
  }

  it('deactivates every DEK and schedules KMS deletion for each unique KEK', async () => {
    const { cryptoshredOrg } = await import('../../src/shared/kms/tenant-dek.js');
    const orgId = uuidv7();
    const rows = [
      {
        id: uuidv7(),
        orgId,
        purpose: 'PII',
        kekKeyId: 'arn:aws:kms:1',
        isActive: true,
        retiredAt: null,
      },
      {
        id: uuidv7(),
        orgId,
        purpose: 'AUDIT',
        kekKeyId: 'arn:aws:kms:2',
        isActive: true,
        retiredAt: null,
      },
      {
        id: uuidv7(),
        orgId,
        purpose: 'PII',
        kekKeyId: 'arn:aws:kms:1',
        isActive: false,
        retiredAt: null,
      }, // older version
    ];
    const { prisma } = buildShredStubPrisma(rows);
    const { disabled, scheduled } = trackingKms();

    const result = await cryptoshredOrg(prisma, orgId, 14);

    expect(result.dekCount).toBe(3);
    expect(result.errors).toHaveLength(0);
    // Two unique KEK ARNs across the 3 DEK rows.
    expect(disabled.sort()).toEqual(['arn:aws:kms:1', 'arn:aws:kms:2']);
    expect(scheduled.map((s) => s.kekKeyId).sort()).toEqual(['arn:aws:kms:1', 'arn:aws:kms:2']);
    expect(scheduled.every((s) => s.pendingDays === 14)).toBe(true);
    // All DB rows are now inactive.
    expect(rows.every((r) => r.isActive === false)).toBe(true);
  });

  it('records errors when KMS calls fail but still deactivates DB rows', async () => {
    const { cryptoshredOrg } = await import('../../src/shared/kms/tenant-dek.js');
    const orgId = uuidv7();
    const rows = [
      {
        id: uuidv7(),
        orgId,
        purpose: 'PII',
        kekKeyId: 'arn:flaky',
        isActive: true,
        retiredAt: null,
      },
    ];
    const { prisma } = buildShredStubPrisma(rows);
    setKmsClient({
      generateDataKey: () => Promise.reject(new Error('not used')),
      wrapDataKey: () => Promise.reject(new Error('not used')),
      unwrapDataKey: () => Promise.reject(new Error('not used')),
      disableKey: () => Promise.reject(new Error('IAM denied')),
      scheduleKeyDeletion: () => Promise.reject(new Error('KMS unreachable')),
    });

    const result = await cryptoshredOrg(prisma, orgId);

    expect(result.dekCount).toBe(1);
    expect(result.errors.length).toBe(2); // disable + scheduleKeyDeletion both failed
    expect(result.kmsKeysScheduledForDeletion).toHaveLength(0);
    // DB row still deactivated despite KMS failures — the app-layer
    // protection is intact even if KMS retry is needed.
    expect(rows[0]!.isActive).toBe(false);
  });

  it('returns empty result for an org with no DEK rows', async () => {
    const { cryptoshredOrg } = await import('../../src/shared/kms/tenant-dek.js');
    const orgId = uuidv7();
    const { prisma } = buildShredStubPrisma([]);
    trackingKms();
    const result = await cryptoshredOrg(prisma, orgId);
    expect(result.dekCount).toBe(0);
    expect(result.kmsKeysScheduledForDeletion).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
