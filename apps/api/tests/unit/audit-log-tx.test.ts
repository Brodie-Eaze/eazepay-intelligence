/**
 * SOC2 CC6-021 / CC7.3 — audit-log atomicity.
 *
 * The audit-log helper accepts an optional `tx` argument. When supplied,
 * the audit insert runs against the caller's transaction client. The
 * contract that auditors rely on:
 *
 *   If the enclosing transaction rolls back, the audit row rolls back
 *   with it. Orphan audit rows are impossible. Equally, a mutation that
 *   commits without its audit row is impossible — the audit insert is
 *   part of the same atomic unit of work.
 *
 * This test asserts both halves of that contract using a hand-stubbed
 * transaction client so we don't need a live Postgres for the unit
 * suite. The stub mimics Prisma's $transaction semantics: a thrown
 * error inside the callback discards every write made via the tx
 * client; a return without error commits them.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'c'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

interface FakeRow {
  table: 'user' | 'auditLog';
  data: Record<string, unknown>;
}

/**
 * Minimal Prisma-shaped stub with $transaction semantics: every write
 * inside the callback is captured on `pending`. On clean return the
 * writes are flushed to `committed`. On thrown error `pending` is
 * dropped (i.e. rolled back) and `committed` stays untouched.
 */
function makeFakePrisma(): {
  prisma: {
    auditLog: { create: ReturnType<typeof vi.fn> };
    user: { update: ReturnType<typeof vi.fn> };
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  };
  committed: FakeRow[];
} {
  const committed: FakeRow[] = [];

  const makeTx = (pending: FakeRow[]) => ({
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        pending.push({ table: 'auditLog', data });
        return data;
      }),
    },
    user: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        pending.push({ table: 'user', data });
        return data;
      }),
    },
  });

  const prisma = {
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        committed.push({ table: 'auditLog', data });
        return data;
      }),
    },
    user: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        committed.push({ table: 'user', data });
        return data;
      }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: FakeRow[] = [];
      const tx = makeTx(pending);
      try {
        const result = await fn(tx);
        // Commit phase: flush pending writes into the committed log.
        committed.push(...pending);
        return result;
      } catch (err) {
        // Rollback: drop every write captured during the callback.
        pending.length = 0;
        throw err;
      }
    },
  };

  return { prisma, committed };
}

describe('writeAuditLog — tx atomicity (SOC2 CC6-021)', () => {
  it('writes the audit row using the caller-supplied tx client', async () => {
    const { prisma, committed } = makeFakePrisma();
    // Inject the fake into the database module so the helper picks it up
    // via getPrisma() in the no-tx fallback path. We don't need it for
    // this test (we pass tx), but the import resolves the module.
    vi.resetModules();
    vi.doMock('../../src/config/database.js', () => ({
      getPrisma: () => prisma,
    }));
    const { writeAuditLog } = await import('../../src/shared/middleware/audit-log.middleware.js');

    await prisma.$transaction(async (tx) => {
      await (tx as { user: { update: (a: unknown) => Promise<unknown> } }).user.update({
        where: { id: 'u1' },
        data: { role: 'ADMIN' },
      });
      await writeAuditLog({
        tx: tx as never,
        userId: 'u1',
        action: 'USER_UPDATED',
        resourceType: 'user',
        resourceId: 'u1',
      });
    });

    // Both rows visible after the tx commits.
    expect(committed).toHaveLength(2);
    expect(committed[0]!.table).toBe('user');
    expect(committed[1]!.table).toBe('auditLog');
    expect((committed[1]!.data as { action: string }).action).toBe('USER_UPDATED');

    // The global client.auditLog.create() was NOT invoked — the helper
    // used the tx client we passed in.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    vi.doUnmock('../../src/config/database.js');
  });

  it('rolls back the audit row when the enclosing tx throws', async () => {
    const { prisma, committed } = makeFakePrisma();
    vi.resetModules();
    vi.doMock('../../src/config/database.js', () => ({
      getPrisma: () => prisma,
    }));
    const { writeAuditLog } = await import('../../src/shared/middleware/audit-log.middleware.js');

    const boom = new Error('mutation post-condition failed');

    await expect(
      prisma.$transaction(async (tx) => {
        await (tx as { user: { update: (a: unknown) => Promise<unknown> } }).user.update({
          where: { id: 'u2' },
          data: { role: 'ADMIN' },
        });
        await writeAuditLog({
          tx: tx as never,
          userId: 'u2',
          action: 'USER_UPDATED',
          resourceType: 'user',
          resourceId: 'u2',
        });
        // Something later in the handler fails — e.g. a business-rule
        // check that runs after the audit insert. Prisma rolls the
        // entire tx back. The contract under test: the audit row must
        // roll back too, not survive as an orphan.
        throw boom;
      }),
    ).rejects.toBe(boom);

    // Critical assertion: no rows committed. The audit insert that
    // succeeded *inside* the tx is gone because the tx rolled back.
    expect(committed).toHaveLength(0);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    vi.doUnmock('../../src/config/database.js');
  });

  it('falls back to the global client when tx is omitted', async () => {
    const { prisma, committed } = makeFakePrisma();
    vi.resetModules();
    vi.doMock('../../src/config/database.js', () => ({
      getPrisma: () => prisma,
    }));
    const { writeAuditLog } = await import('../../src/shared/middleware/audit-log.middleware.js');

    await writeAuditLog({
      userId: 'u3',
      action: 'USER_LOGIN',
      resourceType: 'user',
      resourceId: 'u3',
    });

    // Hit the global client directly — fire-and-forget mode.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);

    vi.doUnmock('../../src/config/database.js');
  });
});
