import { Queue } from 'bullmq';
import { getRedis } from '../../config/redis.js';

export const EXPORT_QUEUE_NAME = 'eazepay.export';

export interface ExportJob {
  exportId: string;
}

let queue: Queue<ExportJob> | undefined;

export function getExportQueue(): Queue<ExportJob> {
  if (queue) return queue;
  queue = new Queue<ExportJob>(EXPORT_QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3 * 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    },
  });
  return queue;
}

export async function enqueueExport(job: ExportJob): Promise<void> {
  await getExportQueue().add(`export:${job.exportId}`, job);
}
