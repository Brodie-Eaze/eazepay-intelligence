import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-export' });

import { Worker } from 'bullmq';
import { getRedis } from '../config/redis.js';
import { getPrisma, getPrismaLong } from '../config/database.js';
import { getLogger } from '../config/logger.js';
import { EXPORT_QUEUE_NAME, type ExportJob } from '../shared/queues/export.queue.js';
import { ExportService } from '../domains/exports/export.service.js';

async function main(): Promise<void> {
  const log = getLogger();
  // Writer for Export-row status transitions (read-after-write consistent),
  // long-running role for the bulk row extraction (5-min statement budget,
  // separate connection pool from the API request path). When
  // DATABASE_LONG_URL is unset, the long client falls back to the writer.
  const service = new ExportService(getPrisma(), getPrismaLong());

  const worker = new Worker<ExportJob>(
    EXPORT_QUEUE_NAME,
    async (job) => {
      log.info({ jobId: job.id, exportId: job.data.exportId }, 'export.run.start');
      await service.runExport(job.data.exportId);
      log.info({ jobId: job.id }, 'export.run.done');
    },
    { connection: getRedis(), concurrency: 4, autorun: true },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'export.failed');
  });

  const shutdown = async (): Promise<void> => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
