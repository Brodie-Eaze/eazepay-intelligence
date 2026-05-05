import { Queue } from 'bullmq';
import { getRedis } from '../../config/redis.js';

export const WEBHOOK_DELIVERY_QUEUE_NAME = 'eazepay.webhook-delivery';

export interface WebhookDeliveryJob {
  deliveryId: string;
}

let queue: Queue<WebhookDeliveryJob> | undefined;

export function getWebhookDeliveryQueue(): Queue<WebhookDeliveryJob> {
  if (queue) return queue;
  queue = new Queue<WebhookDeliveryJob>(WEBHOOK_DELIVERY_QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 6, // total: 6 retries with exp backoff
      backoff: { type: 'exponential', delay: 30_000 }, // 30s → 1m → 2m → 4m → 8m → 16m
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 30 * 86_400 },
    },
  });
  return queue;
}

export async function enqueueWebhookDelivery(
  job: WebhookDeliveryJob,
  opts?: { delay?: number },
): Promise<void> {
  await getWebhookDeliveryQueue().add(`deliver:${job.deliveryId}`, job, opts);
}
