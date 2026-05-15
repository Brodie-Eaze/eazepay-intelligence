import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-revenue' });

import { getLogger } from '../config/logger.js';
import { getAggregationQueue } from '../shared/queues/aggregation.queue.js';

/**
 * Revenue worker is a thin scheduler — it enqueues nightly daily-rollup jobs
 * and monthly close jobs into the aggregation queue. Designed to be run as a
 * single-replica process with a node-cron-style scheduler. For now it ticks
 * once at boot (useful in dev) and can be invoked by an external cron in prod.
 */
async function tick(): Promise<void> {
  const log = getLogger();
  const queue = getAggregationQueue();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const monthAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  await queue.add('rollup.daily', {
    period: 'DAILY',
    anchor: yesterday.toISOString(),
    reason: 'cron',
  });
  await queue.add('rollup.monthly', {
    period: 'MONTHLY',
    anchor: monthAnchor.toISOString(),
    reason: 'cron',
  });
  log.info({ ts: now.toISOString() }, 'revenue.worker.scheduled');
}

void tick().then(() => process.exit(0));
