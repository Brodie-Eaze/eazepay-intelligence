import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-aggregation' });

import { Worker } from 'bullmq';
import { getLogger } from '../config/logger.js';
import { getPrisma, getPrismaLong } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { AGGREGATION_QUEUE_NAME, type AggregationJob } from '../shared/queues/aggregation.queue.js';
import { getBootstrapOrgId } from '../shared/tenant/bootstrap-org.js';

/**
 * Materializes daily/monthly/yearly RevenueAggregation rows from the ledger.
 * In a Timescale-rich deployment most analytics read from continuous aggregates,
 * but the rollup keeps cross-cutting numbers (active partner count, funding rate)
 * pre-computed for sub-100ms dashboard reads.
 */
async function main(): Promise<void> {
  const log = getLogger();
  // Reads run on the long-running role (5-min statement budget, separate
  // pool — these aggregations scan millions of rows in big windows and we
  // do NOT want them stealing API request capacity). Writes (the rollup
  // upsert) go to the primary. The rollup output lands in
  // RevenueAggregation, not the source RevenueEvent table, so there's no
  // read-after-write hazard within a single job.
  const reader = getPrismaLong();
  const prisma = getPrisma();

  const worker = new Worker<AggregationJob>(
    AGGREGATION_QUEUE_NAME,
    async (job) => {
      const { period, anchor } = job.data;
      const { from, to } = boundaries(period, new Date(anchor));
      log.info({ jobId: job.id, period, from, to }, 'aggregation.rollup.start');

      const [
        totalRevenue,
        buzzpay,
        pixie,
        micamp,
        totalApps,
        approvedApps,
        fundedApps,
        activePartners,
        newPartners,
        pulls,
        avgDeal,
      ] = await Promise.all([
        reader.revenueEvent.aggregate({
          where: { effectiveAt: { gte: from, lte: to } },
          _sum: { amount: true },
        }),
        reader.revenueEvent.aggregate({
          where: { effectiveAt: { gte: from, lte: to }, stream: 'BUZZPAY' },
          _sum: { amount: true },
        }),
        reader.revenueEvent.aggregate({
          where: { effectiveAt: { gte: from, lte: to }, stream: 'PIXIE' },
          _sum: { amount: true },
        }),
        reader.revenueEvent.aggregate({
          where: { effectiveAt: { gte: from, lte: to }, stream: 'MICAMP' },
          _sum: { amount: true },
        }),
        reader.application.count({ where: { createdAt: { gte: from, lte: to } } }),
        reader.application.count({
          where: { createdAt: { gte: from, lte: to }, status: { in: ['APPROVED', 'FUNDED'] } },
        }),
        reader.application.count({
          where: { createdAt: { gte: from, lte: to }, status: 'FUNDED' },
        }),
        reader.partner.count({ where: { status: 'ACTIVE', deletedAt: null } }),
        reader.partner.count({
          where: { onboardingDate: { gte: from, lte: to }, deletedAt: null },
        }),
        reader.pixieMetric.aggregate({
          where: { period: 'DAILY', periodStart: { gte: from, lte: to } },
          _sum: { dataPullsThisPeriod: true },
        }),
        reader.lenderDecision.aggregate({
          where: { fundingTimestamp: { gte: from, lte: to }, fundingStatus: 'FUNDED' },
          _avg: { fundingAmount: true },
        }),
      ]);

      const approvalRate = totalApps === 0 ? '0' : (approvedApps / totalApps).toFixed(4);
      const fundingRate = approvedApps === 0 ? '0' : (fundedApps / approvedApps).toFixed(4);

      // Phase 1 retrofit: revenue_aggregations now carry org_id. The
      // current aggregation worker computes platform-wide rollups
      // (no per-org breakdown yet). Until per-org rollups land
      // (Phase 1.5 follow-up), every rollup row attaches to the bootstrap
      // org. Once partner_id is org-scoped end-to-end, this loops per
      // organisation.id and runs the aggregations filtered by that org.
      const bootstrapOrgId = await getBootstrapOrgId(prisma);
      await prisma.revenueAggregation.upsert({
        where: { periodStart_period: { periodStart: from, period } },
        create: {
          orgId: bootstrapOrgId,
          period,
          periodStart: from,
          periodEnd: to,
          totalApplications: totalApps,
          approvedApplications: approvedApps,
          fundedApplications: fundedApps,
          buzzpayRevshareTotal: (buzzpay._sum.amount ?? 0).toString(),
          processingFeesTotal: (micamp._sum.amount ?? 0).toString(),
          pixieMarginTotal: (pixie._sum.amount ?? 0).toString(),
          pixieDataPullsTotal: pulls._sum.dataPullsThisPeriod ?? 0,
          activePartnerCount: activePartners,
          newPartnerCount: newPartners,
          totalRevenue: (totalRevenue._sum.amount ?? 0).toString(),
          approvalRate,
          fundingRate,
          avgDealSize: (avgDeal._avg.fundingAmount ?? 0).toString(),
        },
        update: {
          totalApplications: totalApps,
          approvedApplications: approvedApps,
          fundedApplications: fundedApps,
          buzzpayRevshareTotal: (buzzpay._sum.amount ?? 0).toString(),
          processingFeesTotal: (micamp._sum.amount ?? 0).toString(),
          pixieMarginTotal: (pixie._sum.amount ?? 0).toString(),
          pixieDataPullsTotal: pulls._sum.dataPullsThisPeriod ?? 0,
          activePartnerCount: activePartners,
          newPartnerCount: newPartners,
          totalRevenue: (totalRevenue._sum.amount ?? 0).toString(),
          approvalRate,
          fundingRate,
          avgDealSize: (avgDeal._avg.fundingAmount ?? 0).toString(),
        },
      });

      log.info({ jobId: job.id }, 'aggregation.rollup.done');
    },
    { connection: getRedis(), concurrency: 2, autorun: true },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'aggregation.failed');
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    try {
      log.info({ signal }, 'aggregation.worker.shutdown.begin');
      await worker.close();
      process.exit(0);
    } catch (err) {
      // worker.close() rejection would otherwise hang shutdown — force a
      // non-zero exit so the orchestrator restarts us instead of leaving
      // the pod in an indeterminate state.
      log.error({ err, signal }, 'aggregation.worker.shutdown.failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function boundaries(period: AggregationJob['period'], anchor: Date): { from: Date; to: Date } {
  const start = new Date(anchor);
  switch (period) {
    case 'DAILY':
      start.setUTCHours(0, 0, 0, 0);
      return { from: start, to: new Date(start.getTime() + 86_399_999) };
    case 'MONTHLY': {
      const f = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      const t = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1);
      return { from: f, to: t };
    }
    case 'YEARLY': {
      const f = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
      const t = new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1) - 1);
      return { from: f, to: t };
    }
  }
}

void main();
