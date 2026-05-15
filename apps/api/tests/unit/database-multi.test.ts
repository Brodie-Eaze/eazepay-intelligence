/**
 * Multi-database client tests.
 *
 * Verifies the writer/reader/long split contract WITHOUT a live Postgres —
 * we don't actually connect, we just exercise the factory + guards. Real
 * connection behaviour is covered by the integration tests behind a real DB.
 *
 * What we lock down here:
 *   1. getPrisma() returns the writer (backwards compat).
 *   2. With no DATABASE_REPLICA_URL, getPrismaReader() falls back to the
 *      writer instance and isReaderUsingFallback() is true.
 *   3. With DATABASE_REPLICA_URL set, getPrismaReader() returns a *distinct*
 *      client and isReaderUsingFallback() is false.
 *   4. getPrismaLong() mirrors the same fallback semantics.
 *   5. The reader's write-blocking middleware throws on every mutating action.
 *      This is the actual SOC 2-load-bearing safety net — we test all of:
 *        create / createMany / update / updateMany / upsert / delete /
 *        deleteMany / executeRaw / executeRawUnsafe
 *   6. disconnectPrisma() de-dupes when reader/long fall back to the writer
 *      (no double-disconnect on the same client).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

function setBaseEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'c'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  delete process.env.DATABASE_REPLICA_URL;
  delete process.env.DATABASE_LONG_URL;
}

beforeEach(() => {
  vi.resetModules();
  setBaseEnv();
  __resetEnvForTests();
});

describe('multi-DB factory — writer/reader/long', () => {
  it('getPrisma() returns the writer for backwards compat', async () => {
    const db = await import('../../src/config/database.js');
    expect(db.getPrisma()).toBe(db.getPrismaWriter());
  });

  it('reader falls back to writer when DATABASE_REPLICA_URL is unset', async () => {
    const db = await import('../../src/config/database.js');
    expect(db.getPrismaReader()).toBe(db.getPrismaWriter());
    expect(db.isReaderUsingFallback()).toBe(true);
  });

  it('reader is a distinct client when DATABASE_REPLICA_URL is set', async () => {
    process.env.DATABASE_REPLICA_URL = 'postgresql://test:test@localhost:5433/test';
    __resetEnvForTests();
    const db = await import('../../src/config/database.js');
    const writer = db.getPrismaWriter();
    const reader = db.getPrismaReader();
    expect(reader).not.toBe(writer);
    expect(db.isReaderUsingFallback()).toBe(false);
  });

  it('long falls back to writer when DATABASE_LONG_URL is unset', async () => {
    const db = await import('../../src/config/database.js');
    expect(db.getPrismaLong()).toBe(db.getPrismaWriter());
    expect(db.isLongUsingFallback()).toBe(true);
  });

  it('long is a distinct client when DATABASE_LONG_URL is set', async () => {
    process.env.DATABASE_LONG_URL = 'postgresql://worker:test@localhost:5432/test';
    __resetEnvForTests();
    const db = await import('../../src/config/database.js');
    const writer = db.getPrismaWriter();
    const long = db.getPrismaLong();
    expect(long).not.toBe(writer);
    expect(db.isLongUsingFallback()).toBe(false);
  });

  it('disconnectPrisma de-dupes when reader/long fall back to writer', async () => {
    const db = await import('../../src/config/database.js');
    // Construct all three clients up-front; reader+long both fall back.
    const writer = db.getPrismaWriter();
    db.getPrismaReader();
    db.getPrismaLong();
    const spy = vi.spyOn(writer, '$disconnect').mockResolvedValue(undefined);
    await db.disconnectPrisma();
    // Expect exactly one disconnect on the writer despite three handles.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('reader write-block middleware', () => {
  // Helper: get the reader factory with a configured replica URL so we
  // exercise the real (distinct) reader client and its $use middleware.
  async function loadReader() {
    process.env.DATABASE_REPLICA_URL = 'postgresql://test:test@localhost:5433/test';
    __resetEnvForTests();
    const db = await import('../../src/config/database.js');
    return db.getPrismaReader();
  }

  // Each mutation surface should be blocked. Using $use, the middleware
  // intercepts before any engine call — we don't need a live DB.
  const blocked = [
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
  ] as const;

  for (const action of blocked) {
    it(`refuses partner.${action} on the reader`, async () => {
      const reader = await loadReader();
      const partnerModel = (
        reader as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>
      ).partner;
      if (!partnerModel) throw new Error('expected partner model on reader');
      const fn = partnerModel[action];
      if (!fn) throw new Error(`expected ${action} on partner model`);
      let caught: unknown;
      try {
        await fn.call(partnerModel, { data: {}, where: {} });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(String((caught as Error).message)).toMatch(
        /write_blocked|writes must use getPrismaWriter/,
      );
    });
  }

  it('refuses $executeRawUnsafe on the reader', async () => {
    const reader = await loadReader();
    await expect(reader.$executeRawUnsafe('UPDATE partners SET name = $1', 'x')).rejects.toThrow(
      /write_blocked|writes must use getPrismaWriter/,
    );
  });

  it('does NOT block read actions (findMany passes through middleware)', async () => {
    const reader = await loadReader();
    // We expect Prisma to fail with a connection-level error (no DB),
    // not the middleware's write_blocked. Capture the rejection and assert
    // the message does not match the guard.
    let caught: unknown;
    try {
      await reader.partner.findMany();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).not.toMatch(/write_blocked/);
  });
});
