import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../config/database.js';
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
