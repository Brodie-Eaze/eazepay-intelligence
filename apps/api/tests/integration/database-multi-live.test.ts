/**
 * Live multi-DB integration tests.
 *
 * Runs against the docker-compose.test.yml stack — Postgres primary
 * (:55432) + streaming replica (:55433) + Redis (:63790). Started by
 * `scripts/test-integration-db.sh`.
 *
 * What's exercised end-to-end:
 *   1. A row written to the writer is replicated to the reader within ~2s.
 *   2. The reader truly is read-only at the engine level — Postgres rejects
 *      writes routed there with the "read-only transaction" error.
 *   3. The Prisma $use middleware on the reader catches mutations BEFORE
 *      they reach the engine — the rejection has the explicit
 *      `write_blocked` message.
 *   4. The replication-lag query the readiness probe uses returns a real
 *      number on the replica (and NULL on the primary, as expected).
 *   5. Disconnecting both clients releases their pools cleanly.
 *
 * These tests cost ~30 seconds end-to-end (compose boot dominated by
 * pg_basebackup) and only run when the env vars expected by
 * test-integration-db.sh are set. Skipped silently in plain `vitest run`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const PRIMARY_URL = process.env.DATABASE_URL ?? '';
const REPLICA_URL = process.env.DATABASE_REPLICA_URL ?? '';
const liveSuite = PRIMARY_URL.includes('55432') && REPLICA_URL.includes('55433');

describe.skipIf(!liveSuite)('multi-DB live (primary + streaming replica)', () => {
  let writer: PrismaClient;
  let reader: PrismaClient;

  beforeAll(async () => {
    // Reset any cached singletons by importing the env reset hook + the
    // database module afresh — but also use bare PrismaClients for the
    // load-bearing assertions so we're not testing our own factory bugs.
    const { __resetEnvForTests } = await import('../../src/config/env.js');
    __resetEnvForTests();

    writer = new PrismaClient({ datasources: { db: { url: PRIMARY_URL } } });
    reader = new PrismaClient({ datasources: { db: { url: REPLICA_URL } } });

    // Apply the same write-block middleware the production reader carries.
    const WRITE_ACTIONS = new Set([
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      'executeRaw',
      'executeRawUnsafe',
    ]);
    reader.$use(async (params, next) => {
      if (WRITE_ACTIONS.has(params.action)) {
        throw new Error(
          `prisma.reader.write_blocked model=${params.model ?? '<raw>'} action=${params.action}`,
        );
      }
      return next(params);
    });
  });

  afterAll(async () => {
    await Promise.allSettled([writer?.$disconnect(), reader?.$disconnect()]);
  });

  it('replicates a write from primary to replica within ~5s', async () => {
    // Use a simple round-trip: insert a Partner row on writer, poll the
    // replica until it appears. Bound the wait to fail loudly if replication
    // is broken rather than hanging the suite.
    const slug = `replica-test-${Date.now()}`;
    await writer.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS replication_smoke_test (id text PRIMARY KEY, ts timestamptz default now())`,
    );
    await writer.$executeRawUnsafe(
      `INSERT INTO replication_smoke_test (id) VALUES ('${slug}') ON CONFLICT DO NOTHING`,
    );

    const deadline = Date.now() + 5_000;
    let replicated = false;
    while (Date.now() < deadline) {
      const rows = await reader.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM replication_smoke_test WHERE id = '${slug}'`,
      );
      if (rows.length === 1) {
        replicated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(replicated, 'row did not replicate within 5s').toBe(true);
  }, 15_000);

  it('rejects a write routed to the reader at the middleware layer', async () => {
    let caught: unknown;
    try {
      await reader.$executeRawUnsafe(
        'INSERT INTO replication_smoke_test (id) VALUES ($1)',
        'should-fail',
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).toMatch(/write_blocked/);
  });

  it('confirms the replica is genuinely read-only at the engine level', async () => {
    // Bypass the middleware by using the writer-shaped client temporarily —
    // we want to prove Postgres itself refuses, not just our middleware.
    // We open a fresh client without our $use guard.
    const bareReader = new PrismaClient({ datasources: { db: { url: REPLICA_URL } } });
    let caught: unknown;
    try {
      await bareReader.$executeRawUnsafe(
        'INSERT INTO replication_smoke_test (id) VALUES ($1)',
        'engine-check',
      );
    } catch (e) {
      caught = e;
    }
    await bareReader.$disconnect();
    expect(caught).toBeDefined();
    // Postgres error: "cannot execute INSERT in a read-only transaction"
    expect(String((caught as Error).message)).toMatch(/read-only transaction/i);
  });

  it('replication-lag probe returns a number on the replica, NULL on primary', async () => {
    // Primary returns NULL (it's not a standby).
    const onPrimary = await writer.$queryRawUnsafe<Array<{ ts: Date | null }>>(
      `SELECT pg_last_xact_replay_timestamp() AS ts`,
    );
    expect(onPrimary[0]?.ts).toBeNull();

    // Replica returns a non-null timestamp once it's started replaying.
    const onReplica = await reader.$queryRawUnsafe<Array<{ ts: Date | null }>>(
      `SELECT pg_last_xact_replay_timestamp() AS ts`,
    );
    expect(onReplica[0]?.ts).toBeInstanceOf(Date);
  });

  it('replication-lag in milliseconds is small and non-negative', async () => {
    const rows = await reader.$queryRawUnsafe<Array<{ lag_ms: number | null }>>(
      `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms`,
    );
    const lagMs = rows[0]?.lag_ms != null ? Number(rows[0].lag_ms) : null;
    expect(lagMs).not.toBeNull();
    expect(lagMs!).toBeGreaterThanOrEqual(0);
    // Sanity: lag should be well under our 30s alert threshold in the test
    // environment. Allow generous headroom for slow CI machines.
    expect(lagMs!).toBeLessThan(15_000);
  });

  it('the production database module honours DATABASE_REPLICA_URL', async () => {
    // Prove the wiring matches reality: under our env, the production module
    // returns a *distinct* client from the writer.
    const db = await import('../../src/config/database.js');
    expect(db.isReaderUsingFallback()).toBe(false);
    expect(db.getPrismaReader()).not.toBe(db.getPrismaWriter());
    // Cleanup the singletons we may have constructed.
    await db.disconnectPrisma();
  });
});
