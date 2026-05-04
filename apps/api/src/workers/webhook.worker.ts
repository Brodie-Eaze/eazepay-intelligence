import { Worker } from 'bullmq';
import { getRedis } from '../config/redis.js';
import { getPrisma } from '../config/database.js';
import { getLogger } from '../config/logger.js';
import { WEBHOOK_QUEUE_NAME, type WebhookJob } from '../shared/queues/webhook.queue.js';
import { WebhookProcessor } from '../domains/webhooks/webhook.service.js';

/**
 * Webhook worker — runs as its own process (`pnpm --filter api worker:webhook`).
 * In dev, the integrated start script can launch one in-process; in prod, run it
 * as a separate replica. Concurrency tuned for I/O-bound work.
 */
async function main(): Promise<void> {
  const log = getLogger();
  const processor = new WebhookProcessor(getPrisma());

  const worker = new Worker<WebhookJob>(
    WEBHOOK_QUEUE_NAME,
    async (job) => {
      log.info({ jobId: job.id, source: job.data.source, eventType: job.data.eventType }, 'webhook.process.start');
      await processor.process(job.data);
      log.info({ jobId: job.id }, 'webhook.process.done');
    },
    {
      connection: getRedis(),
      concurrency: 8,
      autorun: true,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, attempt: job?.attemptsMade, err: err.message }, 'webhook.process.failed');
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, 'webhook.worker.shutdown.begin');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
