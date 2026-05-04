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

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, 'eazepay.intelligence.api.shutdown.begin');
    try {
      await app.close();
      await disconnectPrisma();
      await disconnectRedis();
      log.info('eazepay.intelligence.api.shutdown.complete');
      process.exit(0);
    } catch (err) {
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
