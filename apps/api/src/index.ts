import { buildServer } from './server.js';
import { getEnv } from './config/env.js';
import { getLogger } from './config/logger.js';
import { disconnectPrisma } from './config/database.js';
import { disconnectRedis } from './config/redis.js';

async function main(): Promise<void> {
  const env = getEnv();
  const log = getLogger();
  const app = await buildServer();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ port: env.PORT, env: env.NODE_ENV }, 'eazepay.intelligence.api.ready');
  } catch (err) {
    log.fatal({ err }, 'eazepay.intelligence.api.bootfail');
    process.exit(1);
  }

  // Graceful shutdown.
  //
  // Order: stop accepting new requests → drain in-flight (Fastify `app.close()`
  // waits for handlers to finish + connections to drain) → disconnect Prisma →
  // disconnect Redis. Hard timeout at 30s so we don't hang an orchestrator
  // restart forever. Re-entrant guard so duplicate signals are ignored.
  //
  // SOC 2 mapping: A1.1 (capacity), A1.2 (availability), CC7.5 (recovery).
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'eazepay.intelligence.api.shutdown.begin');

    const hardTimeout = setTimeout(() => {
      log.fatal('eazepay.intelligence.api.shutdown.hard_timeout');
      process.exit(1);
    }, 30_000);
    hardTimeout.unref();

    try {
      await app.close();
      await disconnectPrisma();
      await disconnectRedis();
      clearTimeout(hardTimeout);
      log.info('eazepay.intelligence.api.shutdown.complete');
      process.exit(0);
    } catch (err) {
      clearTimeout(hardTimeout);
      log.error({ err }, 'eazepay.intelligence.api.shutdown.error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'eazepay.intelligence.api.unhandled_rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'eazepay.intelligence.api.uncaught_exception');
    process.exit(1);
  });
}

void main();
