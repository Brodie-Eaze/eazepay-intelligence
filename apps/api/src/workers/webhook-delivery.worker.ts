import { Worker } from 'bullmq';
import { getRedis } from '../config/redis.js';
import { getPrisma } from '../config/database.js';
import { getLogger } from '../config/logger.js';
import { getEnv } from '../config/env.js';
import {
  WEBHOOK_DELIVERY_QUEUE_NAME,
  type WebhookDeliveryJob,
} from '../shared/queues/webhook-delivery.queue.js';
import { OutboundWebhookService } from '../domains/outbound-webhooks/outbound-webhook.service.js';

async function main(): Promise<void> {
  const log = getLogger();
  const service = new OutboundWebhookService(getPrisma());

  const worker = new Worker<WebhookDeliveryJob>(
    WEBHOOK_DELIVERY_QUEUE_NAME,
    async (job) => {
      log.info(
        { jobId: job.id, deliveryId: job.data.deliveryId, attempt: job.attemptsMade + 1 },
        'webhook-delivery.attempt',
      );
      await service.deliver(job.data.deliveryId);
      log.info({ jobId: job.id }, 'webhook-delivery.done');
    },
    { connection: getRedis(), concurrency: getEnv().WORKER_DELIVERY_CONCURRENCY, autorun: true },
  );

  worker.on('failed', async (job, err) => {
    log.error(
      { jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
      'webhook-delivery.failed',
    );
    if (job?.attemptsMade && job.opts.attempts && job.attemptsMade >= job.opts.attempts) {
      // Final failure → mark abandoned in DB
      const prisma = getPrisma();
      await prisma.webhookDelivery
        .update({ where: { id: job.data.deliveryId }, data: { status: 'ABANDONED' } })
        .catch(() => {});
    }
  });

  const shutdown = async (): Promise<void> => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
