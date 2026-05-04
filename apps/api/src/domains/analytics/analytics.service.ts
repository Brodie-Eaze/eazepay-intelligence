import { Prisma } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { IAnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsRangeQuery } from './analytics.schemas.js';

const CACHE_TTL_SECONDS = 30;

/**
 * Analytics service. Reads live data, projects KPIs, caches the hot endpoints
 * for 30s. Cache is invalidated by webhook worker on relevant writes (we use
 * SET EX rather than DEL-on-write because the webhook worker doesn't need to
 * know which exact endpoints to bust).
 */
export class AnalyticsService {
  constructor(
    private readonly repo: IAnalyticsRepository,
    private readonly redis: Redis,
  ) {}

  async overview(query: AnalyticsRangeQuery): Promise<unknown> {
    const cacheKey = `cache:analytics:overview:${query.from ?? 'na'}:${query.to ?? 'na'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    const priorTo = from;
    const priorFrom = new Date(priorTo.getTime() - (to.getTime() - from.getTime()));

    const [
      totalRevenue,
      priorRevenue,
      approval,
      funding,
      activePartners,
      pixie,
    ] = await Promise.all([
      this.repo.totalRevenue({ from, to }),
      this.repo.totalRevenue({ from: priorFrom, to: priorTo }),
      this.repo.approvalRate({ from, to }),
      this.repo.fundingRate({ from, to }),
      this.repo.activePartnerCount({ since: from }),
      this.repo.pixiePullsLast24h(),
    ]);

    const approvalRate =
      approval.total === 0 ? '0' : new Prisma.Decimal(approval.approved).div(approval.total).toFixed(4);
    const fundingRate =
      funding.approved === 0 ? '0' : new Prisma.Decimal(funding.funded).div(funding.approved).toFixed(4);
    const prior = new Prisma.Decimal(priorRevenue);
    const current = new Prisma.Decimal(totalRevenue);
    const momDelta = prior.isZero() ? '0' : current.minus(prior).div(prior).toFixed(4);

    const body = {
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
    await this.redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(body));
    return body;
  }

  async revenueBreakdown(query: { from?: string; to?: string; bucket: 'day' | 'week' | 'month' }): Promise<unknown> {
    // Delegated to RevenueRepository in revenue.service.ts; here we just shape it.
    // Imported lazily to avoid cycle at module load time.
    const { RevenueRepository } = await import('../revenue/revenue.repository.js');
    const { getPrisma } = await import('../../config/database.js');
    const repo = new RevenueRepository(getPrisma());
    const rows = await repo.sumByStream({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      bucket: query.bucket,
    });
    return rows;
  }

  cohorts(): Promise<unknown> {
    return this.repo.cohorts();
  }

  funnel(query: AnalyticsRangeQuery): Promise<unknown> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    return this.repo.funnel({ from, to });
  }

  async partnerLeaderboard(query: AnalyticsRangeQuery & { limit?: number }): Promise<unknown> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    const [leaderboard, tiers] = await Promise.all([
      this.repo.partnerLeaderboard({ from, to, limit: query.limit ?? 25 }),
      this.repo.tierBreakdown(),
    ]);
    return { leaderboard, tiers };
  }

  liveTail(): Promise<unknown> {
    return this.repo.liveTail(50);
  }
}
