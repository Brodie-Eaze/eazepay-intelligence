import { Queue } from 'bullmq';
import { getRedis } from '../../config/redis.js';

export const AGGREGATION_QUEUE_NAME = 'eazepay.aggregation';

export type AggregationJobName = 'rollup.daily' | 'rollup.monthly' | 'rollup.yearly';

export interface AggregationJob {
  period: 'DAILY' | 'MONTHLY' | 'YEARLY';
  anchor: string; // ISO date — what period to roll up
  reason: 'cron' | 'on_write';
}

let queue: Queue<AggregationJob> | undefined;

export function getAggregationQueue(): Queue<AggregationJob> {
  if (queue) return queue;
  queue = new Queue<AggregationJob>(AGGREGATION_QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    },
  });
  return queue;
}
