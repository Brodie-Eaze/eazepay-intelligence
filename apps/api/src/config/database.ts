import { PrismaClient } from '@prisma/client';
import { getEnv } from './env.js';
import { getLogger } from './logger.js';

let cached: PrismaClient | undefined;

/**
 * Single Prisma client per process. Workers and the Fastify server share it
 * so the connection pool is bounded by `?connection_limit=` in DATABASE_URL.
 */
export function getPrisma(): PrismaClient {
  if (cached) return cached;
  const env = getEnv();
  const log = getLogger();

  const client = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
  });

  client.$on('warn', (e) => log.warn({ prisma: e }, 'prisma.warn'));
  client.$on('error', (e) => log.error({ prisma: e }, 'prisma.error'));
  if (env.NODE_ENV === 'development') {
    client.$on('query', (e) => log.debug({ duration: e.duration, query: e.query }, 'prisma.query'));
  }

  cached = client;
  return cached;
}

export async function disconnectPrisma(): Promise<void> {
  if (cached) {
    await cached.$disconnect();
    cached = undefined;
  }
}
