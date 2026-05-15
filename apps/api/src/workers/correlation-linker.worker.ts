import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-correlation-linker' });

/**
 * Application correlation linker worker (GAP-106).
 *
 * Periodic backfill that walks credit_enrichments rows without an
 * applicationId and tries to resolve them via the
 * domains/integration/highsale/correlation-linker module.
 *
 * Run as a separate process: `pnpm --filter api worker:correlation-linker`.
 */
import { getLogger } from '../config/logger.js';
import { getPrisma } from '../config/database.js';
import { resolveBatch } from '../domains/integration/highsale/correlation-linker.js';

const POLL_INTERVAL_MS = Number(process.env.CORRELATION_LINKER_POLL_MS ?? 60_000 * 5);
const BATCH_SIZE = Number(process.env.CORRELATION_LINKER_BATCH ?? 200);

async function main(): Promise<void> {
  const log = getLogger();
  log.info({ pollMs: POLL_INTERVAL_MS, batch: BATCH_SIZE }, 'correlation_linker.worker.start');
  const prisma = getPrisma();
  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'correlation_linker.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  while (running) {
    try {
      const result = await resolveBatch(prisma, BATCH_SIZE);
      log.info(result, 'correlation_linker.batch.done');
      // If we drained, sleep longer; if there's more work, sleep shorter.
      const idle = result.scanned === 0;
      await new Promise((r) => setTimeout(r, idle ? POLL_INTERVAL_MS : POLL_INTERVAL_MS / 5));
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'correlation_linker.loop_error',
      );
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  await prisma.$disconnect();
  process.exit(0);
}

void main();
