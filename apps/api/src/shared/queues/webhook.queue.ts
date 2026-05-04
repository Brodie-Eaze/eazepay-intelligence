import { Queue, type JobsOptions } from 'bullmq';
import { getRedis } from '../../config/redis.js';
import type { WebhookSource } from '@prisma/client';

export const WEBHOOK_QUEUE_NAME = 'eazepay.webhook';

export interface WebhookJob {
  webhookEventId: string;
  source: WebhookSource;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
}

let queue: Queue<WebhookJob> | undefined;

export function getWebhookQueue(): Queue<WebhookJob> {
  if (queue) return queue;
  queue = new Queue<WebhookJob>(WEBHOOK_QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 2_000 }, // 2s → 4 → 8 → … cap at 60s
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 7 * 86_400 },
    },
  });
  return queue;
}

export async function enqueueWebhook(job: WebhookJob, opts?: JobsOptions): Promise<void> {
  await getWebhookQueue().add(`${job.source}:${job.eventType}`, job, opts);
}
