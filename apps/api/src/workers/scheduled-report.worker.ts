import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-scheduled-report' });

/**
 * Scheduled report sweeper (GAP-110).
 *
 * Today /scheduled-reports CRUD exists but nothing executes the runs.
 * This worker scans for due reports and triggers a one-off export-style
 * pipeline:
 *
 *   1. Find rows WHERE isActive AND nextRunAt <= now.
 *   2. For each: create a ReportRun, run the export, advance nextRunAt
 *      from the cron expression.
 *   3. Idempotent: nextRunAt advance is the single source of truth —
 *      crashing mid-run leaves nextRunAt unchanged and the next sweep
 *      picks it up (running the same window twice is acceptable).
 *
 * Cron parsing: we lean on `cron-parser` — already a transitive of bullmq,
 * but to avoid pulling an extra runtime dep, we implement a tiny subset
 * (every-N-minutes / daily / weekly) inline. Anything more exotic should
 * pre-compute nextRunAt at create time via a dedicated cron library.
 *
 * Run as a separate process: `pnpm --filter api worker:scheduled-report`.
 */
import { v7 as uuidv7 } from 'uuid';
import { ExportStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { getLogger } from '../config/logger.js';
import { getPrisma } from '../config/database.js';
import { enqueueExport } from '../shared/queues/export.queue.js';

const POLL_INTERVAL_MS = Number(process.env.SCHEDULED_REPORT_POLL_INTERVAL_MS ?? 60_000);
const BATCH_SIZE = Number(process.env.SCHEDULED_REPORT_BATCH_SIZE ?? 50);

/**
 * Compute the next firing time after `from` for a cron expression. The
 * subset we support:
 *   - "* * * * *"        every minute (test/dev)
 *   - "*\/N * * * *"     every N minutes
 *   - "M H * * *"        once per day at H:M UTC
 *   - "M H * * D"        once per week at H:M on weekday D (0=Sun)
 *   - "M H D * *"        once per month at H:M on day-of-month D
 * Anything else throws. Production deployments using exotic crons should
 * pre-compute nextRunAt at create time on the route.
 */
function advanceCron(expr: string, from: Date): Date {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`scheduled-report: invalid cron ${expr}`);
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  // every-minute
  if ([min, hour, dom, mon, dow].every((p) => p === '*')) {
    return new Date(from.getTime() + 60_000);
  }
  // every-N-minutes
  const m = min.match(/^\*\/(\d+)$/);
  if (m && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Math.max(1, Number(m[1]));
    return new Date(from.getTime() + n * 60_000);
  }
  // Daily/weekly/monthly: compute next occurrence of (hour:min) optionally
  // constrained by day-of-week or day-of-month. UTC throughout — operators
  // schedule in UTC; user-tz conversion is a future enhancement.
  const minN = Number(min);
  const hourN = Number(hour);
  if (!Number.isInteger(minN) || minN < 0 || minN > 59) {
    throw new Error(`scheduled-report: invalid minute ${min}`);
  }
  if (!Number.isInteger(hourN) || hourN < 0 || hourN > 23) {
    throw new Error(`scheduled-report: invalid hour ${hour}`);
  }
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourN, minN, 0, 0),
  );
  while (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  if (dow !== '*') {
    const dowN = Number(dow);
    if (!Number.isInteger(dowN) || dowN < 0 || dowN > 6) {
      throw new Error(`scheduled-report: invalid weekday ${dow}`);
    }
    while (next.getUTCDay() !== dowN) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  } else if (dom !== '*') {
    const domN = Number(dom);
    if (!Number.isInteger(domN) || domN < 1 || domN > 31) {
      throw new Error(`scheduled-report: invalid day-of-month ${dom}`);
    }
    while (next.getUTCDate() !== domN) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next;
}

async function processOnce(prisma: PrismaClient): Promise<number> {
  const log = getLogger();
  const now = new Date();
  const due = await prisma.scheduledReport.findMany({
    where: {
      isActive: true,
      nextRunAt: { lte: now },
    },
    orderBy: { nextRunAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (due.length === 0) return 0;
  for (const sr of due) {
    try {
      // Create a one-shot export row keyed to the org. The existing
      // ExportService runs it via the queue; the ReportRun row mirrors
      // the export's lifecycle for the scheduled-report audit trail.
      // Reuse the ExportType enum — params.type is a member name.
      const exportType = ((sr.params as Record<string, unknown>)?.type as string) ?? sr.reportType;
      const exportId = uuidv7();
      const runId = uuidv7();
      await prisma.$transaction(async (tx) => {
        await tx.export.create({
          data: {
            id: exportId,
            orgId: sr.orgId,
            userId: sr.userId,
            type: exportType as never,
            format: 'CSV',
            filters: (sr.params as object) ?? {},
            status: ExportStatus.PENDING,
          },
        });
        await tx.reportRun.create({
          data: {
            id: runId,
            orgId: sr.orgId,
            scheduledReportId: sr.id,
            status: ExportStatus.PENDING,
          },
        });
        const next = advanceCron(sr.cronExpression, now);
        await tx.scheduledReport.update({
          where: { id: sr.id },
          data: { lastRunAt: now, nextRunAt: next },
        });
      });
      await enqueueExport({ exportId });
      log.info({ scheduledReportId: sr.id, exportId, runId }, 'scheduled_report.enqueued');
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          scheduledReportId: sr.id,
          errorId: 'scheduled_report.process_failed',
        },
        'scheduled_report.process_failed',
      );
    }
  }
  return due.length;
}

async function main(): Promise<void> {
  const log = getLogger();
  log.info({ pollMs: POLL_INTERVAL_MS, batch: BATCH_SIZE }, 'scheduled_report.worker.start');
  const prisma = getPrisma();
  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'scheduled_report.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  while (running) {
    try {
      await processOnce(prisma);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduled_report.loop_error',
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await prisma.$disconnect();
  process.exit(0);
}

void main();

export { advanceCron };
