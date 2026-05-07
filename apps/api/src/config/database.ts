/**
 * Database access — writer / reader split.
 *
 * Two singletons:
 *   getPrismaWriter()  → primary (DATABASE_URL). Writes + read-after-write.
 *   getPrismaReader()  → replica (DATABASE_REPLICA_URL) if set, else writer.
 *                         Heavy analytics + dashboard reads route here.
 *
 * Backward compat: `getPrisma()` returns the writer. Existing code keeps
 * working unchanged; we only opt into the replica where it matters (analytics
 * routes, audit log viewer, portfolio reads).
 *
 * Why split instead of Prisma read-replica plugin?
 *   - We want explicit control. A single mis-routed read on a replica with
 *     stale lag could show wrong revenue numbers; route authors opt in.
 *   - When the replica fails, reads transparently fall back to the writer.
 *     `getPrismaReader()` returns the writer if the replica errors at init
 *     — degraded mode is "primary handles both."
 *
 * SOC 2 mapping:
 *   - A1.1 (capacity)            — replica absorbs read load
 *   - A1.2 (system availability) — reader fallback to writer on failure
 *   - CC7.2 (monitoring)         — slow-query log surfaces hot spots
 *
 * Connection-level safety (enforced at the role level in init-timescale.sql):
 *   - statement_timeout
 *   - idle_in_transaction_session_timeout
 *   - connection_limit + pool_timeout passed via DATABASE_URL query string
 *   - Slow-query threshold logged via Prisma $on('query')
 */
import { PrismaClient } from '@prisma/client';
import { getEnv } from './env.js';
import { getLogger } from './logger.js';

let writerCache: PrismaClient | undefined;
let readerCache: PrismaClient | undefined;
let longCache: PrismaClient | undefined;
let readerIsFallback = false;
let longIsFallback = false;

// Prisma model actions that mutate state. Anything in this set hitting the
// reader is a bug — we either tried to write to a replica (Postgres rejects
// with read-only error, but we want to fail earlier and louder) or we forgot
// a writer/reader split.
const WRITE_ACTIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'executeRaw',
  'executeRawUnsafe',
]);

function buildClient(url: string, label: 'writer' | 'reader'): PrismaClient {
  const env = getEnv();
  const log = getLogger();

  const client = new PrismaClient({
    datasources: { db: { url } },
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  client.$on('warn', (e) => log.warn({ prisma: e, db: label }, 'prisma.warn'));
  client.$on('error', (e) => log.error({ prisma: e, db: label }, 'prisma.error'));
  client.$on('query', (e) => {
    if (e.duration >= env.DATABASE_SLOW_QUERY_LOG_MS) {
      log.warn({ duration: e.duration, query: e.query, db: label }, 'prisma.slow_query');
    } else if (env.NODE_ENV === 'development') {
      log.debug({ duration: e.duration, query: e.query, db: label }, 'prisma.query');
    }
  });

  // Reader-only guard: refuse mutating operations on the read replica client.
  //
  // Postgres will reject these with "cannot execute … in a read-only
  // transaction" anyway — but that error surfaces deep inside Prisma's
  // engine, after we've already burnt a connection round-trip and emitted a
  // confusing stack trace. Catching here gives an immediate, actionable
  // error pointing at the offending model+action.
  //
  // In production the error is downgraded to a critical log + thrown error
  // (the request ends in 500 either way, but this preserves the safety net
  // without conditionalising business logic). In dev/test it's noisy on
  // purpose so the wrong wiring gets caught in PR review or a unit test.
  if (label === 'reader') {
    client.$use(async (params, next) => {
      if (WRITE_ACTIONS.has(params.action)) {
        const message = `prisma.reader.write_blocked model=${params.model ?? '<raw>'} action=${params.action} — writes must use getPrismaWriter()`;
        log.error({ model: params.model, action: params.action }, 'prisma.reader.write_blocked');
        throw new Error(message);
      }
      return next(params);
    });
  }

  return client;
}

/** Writer client. All mutations + read-after-write reads go here. */
export function getPrismaWriter(): PrismaClient {
  if (writerCache) return writerCache;
  const env = getEnv();
  writerCache = buildClient(env.DATABASE_URL, 'writer');
  return writerCache;
}

/**
 * Reader client. Routes to the replica when configured; otherwise writer.
 * Use for analytics, dashboards, heavy aggregations where sub-second
 * replication lag is acceptable.
 */
export function getPrismaReader(): PrismaClient {
  if (readerCache) return readerCache;
  const env = getEnv();
  if (env.DATABASE_REPLICA_URL) {
    try {
      readerCache = buildClient(env.DATABASE_REPLICA_URL, 'reader');
      readerIsFallback = false;
    } catch (err) {
      getLogger().error(
        { err: (err as Error).message },
        'prisma.replica_init_failed_fallback_to_writer',
      );
      readerCache = getPrismaWriter();
      readerIsFallback = true;
    }
  } else {
    readerCache = getPrismaWriter();
    readerIsFallback = true;
  }
  return readerCache;
}

/**
 * Long-running worker client. Connects as the `eazepay_worker_long` role
 * with a 5-minute statement_timeout for export pipelines + aggregation
 * backfills. Falls back to the writer when DATABASE_LONG_URL is unset.
 *
 * Workers should prefer this client for the bulk steps of their job; status
 * mutations on small tables (`Export.status`, etc.) can stay on the writer.
 */
export function getPrismaLong(): PrismaClient {
  if (longCache) return longCache;
  const env = getEnv();
  if (env.DATABASE_LONG_URL) {
    try {
      longCache = buildClient(env.DATABASE_LONG_URL, 'writer');
      longIsFallback = false;
    } catch (err) {
      getLogger().error(
        { err: (err as Error).message },
        'prisma.long_init_failed_fallback_to_writer',
      );
      longCache = getPrismaWriter();
      longIsFallback = true;
    }
  } else {
    longCache = getPrismaWriter();
    longIsFallback = true;
  }
  return longCache;
}

/** Backward-compat alias for the writer. Existing call-sites are unchanged. */
export function getPrisma(): PrismaClient {
  return getPrismaWriter();
}

export function isReaderUsingFallback(): boolean {
  return readerIsFallback;
}

export function isLongUsingFallback(): boolean {
  return longIsFallback;
}

export async function disconnectPrisma(): Promise<void> {
  const writer = writerCache;
  const reader = readerCache;
  const long = longCache;
  writerCache = undefined;
  readerCache = undefined;
  longCache = undefined;
  // De-dupe: if reader/long fell back to the writer, only disconnect once.
  const uniques = new Set<PrismaClient>();
  if (writer) uniques.add(writer);
  if (reader) uniques.add(reader);
  if (long) uniques.add(long);
  await Promise.allSettled([...uniques].map((c) => c.$disconnect()));
}
