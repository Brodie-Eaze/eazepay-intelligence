import { Prisma } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { IAnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsRangeQuery } from './analytics.schemas.js';

/**
 * Analytics service. Reads live data and projects KPIs on every call.
 *
 * Previously cached `/analytics/overview` for 30s. The cache was dropped
 * because there's no invalidation on the write paths that mutate the
 * aggregates (revenue.create, lender_decision.create, etc.) — a user
 * could fund a new application, refresh the overview, and see the old
 * numbers for up to 30s. On a finance dashboard that's a correctness
 * hole, not a perf nit. Re-add a Redis layer ONLY with explicit
 * DEL-on-write from every relevant write path.
 *
 * GAP-108: every public method takes `orgId` and the downstream
 * repositories filter by orgId in every WHERE clause.
 */
export class AnalyticsService {
  constructor(
    private readonly repo: IAnalyticsRepository,
    // Reserved for re-introduction of a cache when DEL-on-write is wired.
    // The constructor signature stays compatible so route handlers don't
    // need to change once cache invalidation lands. Prefixed with `_` so
    // unused-locals lint stays quiet.
    private readonly _redis: Redis,
  ) {}

  async overview(orgId: string, query: AnalyticsRangeQuery): Promise<unknown> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    const priorTo = from;
    const priorFrom = new Date(priorTo.getTime() - (to.getTime() - from.getTime()));

    const [totalRevenue, priorRevenue, approval, funding, activePartners, pixie] =
      await Promise.all([
        this.repo.totalRevenue({ orgId, from, to }),
        this.repo.totalRevenue({ orgId, from: priorFrom, to: priorTo }),
        this.repo.approvalRate({ orgId, from, to }),
        this.repo.fundingRate({ orgId, from, to }),
        this.repo.activePartnerCount({ orgId, since: from }),
        this.repo.pixiePullsLast24h({ orgId }),
      ]);

    const approvalRate =
      approval.total === 0
        ? '0'
        : new Prisma.Decimal(approval.approved).div(approval.total).toFixed(4);
    const fundingRate =
      funding.approved === 0
        ? '0'
        : new Prisma.Decimal(funding.funded).div(funding.approved).toFixed(4);
    const prior = new Prisma.Decimal(priorRevenue);
    const current = new Prisma.Decimal(totalRevenue);
    const momDelta = prior.isZero() ? '0' : current.minus(prior).div(prior).toFixed(4);

    return {
      totalRevenue,
      approvalRate,
      fundingRate,
      activePartnerCount: activePartners,
      pixiePullsLast24h: pixie,
      momRevenueDelta: momDelta,
      windowFrom: from.toISOString(),
      windowTo: to.toISOString(),
      generatedAt: new Date().toISOString(),
    };
  }

  async revenueBreakdown(
    orgId: string,
    query: {
      from?: string;
      to?: string;
      bucket: 'day' | 'week' | 'month';
    },
  ): Promise<unknown> {
    // Delegated to RevenueRepository in revenue.service.ts; here we just shape it.
    // Imported lazily to avoid cycle at module load time.
    const { RevenueRepository } = await import('../revenue/revenue.repository.js');
    const { getPrismaReader } = await import('../../config/database.js');
    // Replica is fine — this aggregation tolerates seconds of replication lag.
    const repo = new RevenueRepository(getPrismaReader());
    const rows = await repo.sumByStream({
      orgId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      bucket: query.bucket,
    });
    return rows;
  }

  cohorts(orgId: string): Promise<unknown> {
    return this.repo.cohorts({ orgId });
  }

  funnel(orgId: string, query: AnalyticsRangeQuery): Promise<unknown> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    return this.repo.funnel({ orgId, from, to });
  }

  async partnerLeaderboard(
    orgId: string,
    query: AnalyticsRangeQuery & { limit?: number },
  ): Promise<unknown> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    const [leaderboard, tiers] = await Promise.all([
      this.repo.partnerLeaderboard({ orgId, from, to, limit: query.limit ?? 25 }),
      this.repo.tierBreakdown({ orgId }),
    ]);
    return { leaderboard, tiers };
  }

  liveTail(orgId: string): Promise<unknown> {
    return this.repo.liveTail({ orgId, limit: 50 });
  }
}
