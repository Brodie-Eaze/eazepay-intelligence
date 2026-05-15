import type { FastifyInstance } from 'fastify';
import { getPrismaReader } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { errors } from '../../shared/errors/app-error.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { partnerLabel } from '../partners/partner.types.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { AnalyticsService } from './analytics.service.js';
import { AnalyticsRangeQuerySchema, AnalyticsRevenueQuerySchema } from './analytics.schemas.js';

/**
 * GAP-108: every analytics endpoint is scoped by `req.auth.orgId` (set
 * at login from the user's oldest membership in auth.service.ts, or by
 * the tenant-resolution middleware on /o/:orgSlug routes). A dashboard
 * user without an active org cannot see analytics — they have to enter
 * an org first. Platform-staff cross-org analytics live on /platform/*.
 */
function requireOrgScope(orgId: string | undefined): string {
  if (!orgId) {
    throw errors.badRequest('Analytics requires an active organisation');
  }
  return orgId;
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  // Reader. Analytics endpoints are read-only and tolerate sub-second
  // replication lag — exactly the workload the replica is sized for.
  // When DATABASE_REPLICA_URL is unset, this transparently falls back to
  // the writer (see config/database.ts).
  const reader = getPrismaReader();
  const service = new AnalyticsService(new AnalyticsRepository(reader), getRedis());

  app.get('/analytics/overview', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRangeQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    return service.overview(orgId, query);
  });

  app.get('/analytics/revenue', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRevenueQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    return service.revenueBreakdown(orgId, query);
  });

  app.get('/analytics/lenders', { preHandler: requireAuth }, async (req) => {
    // Delegate to lender service for the same payload shape.
    const orgId = requireOrgScope(req.auth?.orgId);
    const { LenderRepository } = await import('../lenders/lender.repository.js');
    const { LenderService } = await import('../lenders/lender.service.js');
    const { LenderRangeQuerySchema } = await import('../lenders/lender.schemas.js');
    const svc = new LenderService(new LenderRepository(reader));
    return svc.waterfall(orgId, LenderRangeQuerySchema.parse(req.query));
  });

  app.get('/analytics/partners', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRangeQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    const result = (await service.partnerLeaderboard(orgId, query)) as {
      leaderboard: Array<{
        partnerId: string;
        partnerName: string;
        tier: string;
        revenue: string;
        applications: number;
        approved: number;
        funded: number;
      }>;
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

  app.get('/analytics/cohorts', { preHandler: requireAuth }, async (req) => {
    const orgId = requireOrgScope(req.auth?.orgId);
    return service.cohorts(orgId);
  });

  app.get('/analytics/funnel', { preHandler: requireAuth }, async (req) => {
    const query = AnalyticsRangeQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    return service.funnel(orgId, query);
  });

  app.get('/analytics/live', { preHandler: requireAuth }, async (req) => {
    const orgId = requireOrgScope(req.auth?.orgId);
    const tail = (await service.liveTail(orgId)) as Array<{
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
