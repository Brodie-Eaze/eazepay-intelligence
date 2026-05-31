import type { FastifyInstance } from 'fastify';
import {
  getPrisma,
  getPrismaReader,
  getPrismaLong,
  isReaderUsingFallback,
  isLongUsingFallback,
} from '../config/database.js';
import { getRedis } from '../config/redis.js';

interface DependencyStatus {
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  uptimeSeconds: number;
  version: string;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

const VERSION = process.env.npm_package_version ?? '0.1.0';
const startedAt = Date.now();

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async (_req, reply) => {
    const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
    // 2026-05-30 hotfix: Redis on Railway shared infra flaps intermittently.
    // Previously, redis.status === 'down' propagated to overall 'down' → 503,
    // which tripped the Railway platform healthcheck + Cloudflare and took
    // the whole API offline (dashboard couldn't even load /auth/me, which
    // doesn't touch Redis on the hot path). Postgres is the only true
    // hard dependency: deny-list, rate-limit, and session lookups already
    // fail open when Redis is unreachable, so a Redis outage is operationally
    // a degraded — not down — state. Only Postgres-down returns 503.
    const overall: HealthResponse['status'] =
      database.status === 'down'
        ? 'down'
        : database.status === 'degraded' ||
            redis.status === 'down' ||
            redis.status === 'degraded'
          ? 'degraded'
          : 'ok';

    const body: HealthResponse = {
      status: overall,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: VERSION,
      checks: { database, redis },
    };

    reply.status(overall === 'down' ? 503 : 200).send(body);
  });

  // /health/live — liveness. Process is up; no dependency checks.
  // K8s / ECS uses this to decide whether to restart the container.
  app.get('/health/live', async (_req, reply) => {
    reply.status(200).send({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  // /health/ready — readiness. Primary + Redis must be reachable. The replica
  // is a soft check: if it's down we degrade to "primary handles both" — still
  // ready to serve traffic, but operators get a `replica: degraded` signal.
  // K8s / ECS uses this to decide whether to route traffic here.
  app.get('/health/ready', async (_req, reply) => {
    const [database, redis, replica] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkReplica(),
    ]);
    const ready = database.status === 'ok' && redis.status === 'ok';
    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: database.status,
        redis: redis.status,
        replica: replica.status,
        replicaConfigured: !isReaderUsingFallback(),
        longRoleConfigured: !isLongUsingFallback(),
        ...(replica.lagMs !== undefined ? { replicaLagMs: replica.lagMs } : {}),
      },
    });
  });

  // Prisma pool metrics moved into shared/metrics/metrics.routes.ts so we
  // have one /metrics endpoint emitting BOTH Prisma pool stats and the
  // domain counters (SEC-305 fix — duplicate route would crash Fastify).
  // The metrics route at /metrics now fans out to `prismaPoolMetricsText()`
  // exported below.
}

/** Emit Prisma pool metrics in Prometheus text format. Imported by
 *  shared/metrics/metrics.routes.ts so /metrics carries both surfaces.
 */
export async function prismaPoolMetricsText(): Promise<string> {
  const writer = await getPrisma().$metrics.prometheus({ globalLabels: { db: 'writer' } });
  const reader = isReaderUsingFallback()
    ? ''
    : await getPrismaReader().$metrics.prometheus({ globalLabels: { db: 'reader' } });
  const long = isLongUsingFallback()
    ? ''
    : await getPrismaLong().$metrics.prometheus({ globalLabels: { db: 'long' } });
  return writer + reader + long;
}

/**
 * Replica health + replication lag.
 *
 * When a replica is configured, we don't just check it can answer SELECT 1 —
 * we also measure how far it's lagging the primary using
 * `pg_last_xact_replay_timestamp()`. Lag above 30 seconds is operationally
 * meaningful: analytics dashboards stop being a fair representation of the
 * write path. We surface this as `lag: degraded` so ops sees it without
 * failing readiness (the reader still falls back to the writer transparently,
 * so the platform stays available).
 *
 * SOC 2 mapping:
 *   - A1.2 (availability) — explicit signal when reads diverge from writes
 *   - CC7.2 (monitoring)  — replication lag is a leading indicator of
 *                            replica problems hours before they cascade
 */
async function checkReplica(): Promise<DependencyStatus & { lagMs?: number }> {
  if (isReaderUsingFallback()) return { status: 'ok' };
  const t = Date.now();
  try {
    await getPrismaReader().$queryRaw`SELECT 1`;
    // pg_last_xact_replay_timestamp() returns NULL on the primary and the
    // last replayed-tx timestamp on a standby. Lag = now() - that ts.
    const rows = await getPrismaReader().$queryRaw<{ lag_ms: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms
    `;
    const lagMs = rows[0]?.lag_ms != null ? Math.round(Number(rows[0].lag_ms)) : undefined;
    const overLagBudget = lagMs !== undefined && lagMs > 30_000;
    return {
      status: overLagBudget ? 'degraded' : 'ok',
      latencyMs: Date.now() - t,
      ...(lagMs !== undefined ? { lagMs } : {}),
    };
  } catch (err) {
    return { status: 'degraded', error: (err as Error).message };
  }
}

async function checkDatabase(): Promise<DependencyStatus> {
  const t = Date.now();
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - t };
  } catch (err) {
    return { status: 'down', error: (err as Error).message };
  }
}

async function checkRedis(): Promise<DependencyStatus> {
  const t = Date.now();
  try {
    const pong = await getRedis().ping();
    return { status: pong === 'PONG' ? 'ok' : 'degraded', latencyMs: Date.now() - t };
  } catch (err) {
    return { status: 'down', error: (err as Error).message };
  }
}
