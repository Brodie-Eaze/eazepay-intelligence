import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-retention' });

/**
 * Data retention worker (Phase H).
 *
 * Three tables grow unbounded without active pruning:
 *
 *   1. outbox_events — every webhook + WS pub + outbound-webhook delivery
 *      writes a row. Retention: keep published rows for OUTBOX_RETENTION_DAYS
 *      (default 90) post-publishedAt. DLQ rows (dlqedAt != null) are
 *      kept indefinitely until an operator acks them.
 *
 *   2. lender_reporting_events — append-only audit trail per adapter
 *      call (submit / poll / state-transition). Retention:
 *      LENDER_REPORTING_RETENTION_DAYS (default 365 — keep one full
 *      financial year for downstream reconciliation).
 *
 *   3. audit_logs — already governed by SOC 2 retention; the role
 *      REVOKE DELETE on audit_logs makes this immune to runtime pruning.
 *      Pruning audit_logs is a manual ops action with operator + privacy
 *      review, not this worker.
 *
 * SOC 2 alignment: CC4.1 (retention period documented), CC6.5
 * (information deletion in line with policy).
 *
 * Operational envelope:
 *   - Sleeps RETENTION_TICK_HOURS (default 24h) between sweeps.
 *   - Batches DELETE up to RETENTION_BATCH_SIZE (default 1000) rows
 *     per tick to keep tx duration bounded.
 *   - Idempotent — every tick re-computes the cutoff, so a missed run
 *     is harmless (next tick catches up).
 */
import type { PrismaClient } from '@prisma/client';
import { getLogger } from '../config/logger.js';
import { getPrisma } from '../config/database.js';

const TICK_HOURS = Number(process.env.RETENTION_TICK_HOURS ?? 24);
const BATCH_SIZE = Number(process.env.RETENTION_BATCH_SIZE ?? 1_000);
const OUTBOX_RETENTION_DAYS = Number(process.env.OUTBOX_RETENTION_DAYS ?? 90);
const LENDER_REPORTING_RETENTION_DAYS = Number(process.env.LENDER_REPORTING_RETENTION_DAYS ?? 365);

async function pruneOutbox(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000);
  // Prisma deleteMany doesn't take LIMIT; raw $executeRaw for the bound.
  // DLQ rows (dlqedAt != null) are preserved until an operator clears them.
  const deleted: { count: number }[] = await prisma.$queryRaw`
    WITH victims AS (
      SELECT id FROM outbox_events
      WHERE published_at IS NOT NULL
        AND published_at < ${cutoff}::timestamptz
        AND dlqed_at IS NULL
      LIMIT ${BATCH_SIZE}
    )
    DELETE FROM outbox_events
    WHERE id IN (SELECT id FROM victims)
    RETURNING 1 AS count
  `;
  return deleted.length;
}

async function pruneLenderReporting(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - LENDER_REPORTING_RETENTION_DAYS * 86_400_000);
  const deleted: { count: number }[] = await prisma.$queryRaw`
    WITH victims AS (
      SELECT id FROM lender_reporting_events
      WHERE observed_at < ${cutoff}::timestamptz
      LIMIT ${BATCH_SIZE}
    )
    DELETE FROM lender_reporting_events
    WHERE id IN (SELECT id FROM victims)
    RETURNING 1 AS count
  `;
  return deleted.length;
}

async function tick(prisma: PrismaClient): Promise<void> {
  const log = getLogger();
  try {
    const outbox = await pruneOutbox(prisma);
    if (outbox > 0) log.info({ deleted: outbox }, 'retention.outbox.pruned');
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'retention.outbox.error');
  }
  try {
    const lender = await pruneLenderReporting(prisma);
    if (lender > 0) log.info({ deleted: lender }, 'retention.lender_reporting.pruned');
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'retention.lender_reporting.error',
    );
  }
}

async function main(): Promise<void> {
  const log = getLogger();
  log.info(
    {
      tickHours: TICK_HOURS,
      batchSize: BATCH_SIZE,
      outboxRetentionDays: OUTBOX_RETENTION_DAYS,
      lenderRetentionDays: LENDER_REPORTING_RETENTION_DAYS,
    },
    'retention.worker.start',
  );
  const prisma = getPrisma();
  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'retention.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  while (running) {
    await tick(prisma);
    await new Promise((r) => setTimeout(r, TICK_HOURS * 3600 * 1000));
  }
  await prisma.$disconnect();
  process.exit(0);
}

void main();
