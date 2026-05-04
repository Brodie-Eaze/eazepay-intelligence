import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from './env.js';
import { getLogger } from './logger.js';

let cached: Redis | undefined;
let pubCached: Redis | undefined;
let subCached: Redis | undefined;

function buildOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null, // BullMQ requires null
    enableReadyCheck: true,
    lazyConnect: false,
  };
}

/** Default Redis client — for cache, idempotency, rate limit. */
export function getRedis(): Redis {
  if (cached) return cached;
  const log = getLogger();
  cached = new Redis(getEnv().REDIS_URL, buildOptions());
  cached.on('error', (err) => log.error({ err }, 'redis.error'));
  cached.on('connect', () => log.info('redis.connected'));
  return cached;
}

/** Pub side — for WS fanout. Must be a separate connection from sub. */
export function getRedisPublisher(): Redis {
  if (pubCached) return pubCached;
  pubCached = new Redis(getEnv().REDIS_URL, buildOptions());
  return pubCached;
}

/** Sub side — for WS fanout. Subscriber connections cannot run other commands. */
export function getRedisSubscriber(): Redis {
  if (subCached) return subCached;
  subCached = new Redis(getEnv().REDIS_URL, buildOptions());
  return subCached;
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([
    cached?.quit().catch(() => undefined),
    pubCached?.quit().catch(() => undefined),
    subCached?.quit().catch(() => undefined),
  ]);
  cached = undefined;
  pubCached = undefined;
  subCached = undefined;
}
