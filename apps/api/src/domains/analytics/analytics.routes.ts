import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { partnerLabel } from '../partners/partner.types.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { AnalyticsService } from './analytics.service.js';
import {
  AnalyticsRangeQuerySchema,
  AnalyticsRevenueQuerySchema,
} from './analytics.schemas.js';

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const service = new AnalyticsService(new AnalyticsRepository(getPrisma()), getRedis());

  app.get('/analytics/overview', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRangeQuerySchema.parse(req.query);
    return service.overview(query);
  });

  app.get('/analytics/revenue', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRevenueQuerySchema.parse(req.query);
    return service.revenueBreakdown(query);
  });

  app.get('/analytics/lenders', { preHandler: requireAuth }, async (req) => {
    // Delegate to lender service for the same payload shape.
    const { LenderRepository } = await import('../lenders/lender.repository.js');
    const { LenderService } = await import('../lenders/lender.service.js');
    const { LenderRangeQuerySchema } = await import('../lenders/lender.schemas.js');
    const svc = new LenderService(new LenderRepository(getPrisma()));
    return svc.waterfall(LenderRangeQuerySchema.parse(req.query));
  });

  app.get('/analytics/partners', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRangeQuerySchema.parse(req.query);
    const result = (await service.partnerLeaderboard(query)) as {
      leaderboard: Array<{ partnerId: string; partnerName: string; tier: string; revenue: string; applications: number; approved: number; funded: number }>;
      tiers: Array<{ tier: string; count: number }>;
    };
    const isInvestor = req.auth!.scope === 'investor';
    return {
      leaderboard: result.leaderboard.map((r) => ({
        partnerId: r.partnerId,
        partnerLabel: isInvestor ? partnerLabel(r.partnerId) : r.partnerName,
        tier: r.tier,
        applications: r.applications,
        approved: r.approved,
        funded: r.funded,
        revenue: r.revenue,
      })),
      tiers: result.tiers,
    };
  });

  app.get('/analytics/cohorts', { preHandler: requireAuth }, async () => {
    return service.cohorts();
  });

  app.get('/analytics/funnel', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRangeQuerySchema.parse(req.query);
    return service.funnel(query);
  });

  app.get('/analytics/live', { preHandler: requireAuth }, async (req) => {
    const tail = (await service.liveTail()) as Array<{
      eventTime: string;
      kind: string;
      partnerId: string;
      partnerName: string;
      description: string;
      amount: string | null;
    }>;
    const isInvestor = req.auth!.scope === 'investor';
    return tail.map((e) => ({
      ...e,
      partnerName: isInvestor ? partnerLabel(e.partnerId) : e.partnerName,
    }));
  });
}
