import type { FastifyInstance } from 'fastify';
import { getPrisma, getPrismaReader, isReaderUsingFallback } from '../config/database.js';
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
    const overall: HealthResponse['status'] =
      database.status === 'down' || redis.status === 'down'
        ? 'down'
        : database.status === 'degraded' || redis.status === 'degraded'
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
      },
    });
  });
}

async function checkReplica(): Promise<DependencyStatus> {
  // If no replica is configured, we report 'ok' — we're not pretending the
  // primary is the replica, the readiness handler reflects this in
  // `replicaConfigured: false`.
  if (isReaderUsingFallback()) return { status: 'ok' };
  const t = Date.now();
  try {
    await getPrismaReader().$queryRaw`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - t };
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
