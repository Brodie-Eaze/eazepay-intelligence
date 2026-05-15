/**
 * GET /api/v1/aurean-recruitment/kpis  (GAP-104 KPI surface)
 *
 * Per-org placement-fee KPIs. Pipeline counts come from the webhook
 * event stream; commission totals + clawbacks come from the revenue
 * ledger.
 */
import type { FastifyInstance } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { getPrismaReader } from '../../../config/database.js';
import { errors } from '../../../shared/errors/app-error.js';
import { requireAuth } from '../../../shared/middleware/auth.middleware.js';

function requireOrgScope(orgId: string | undefined): string {
  if (!orgId) throw errors.badRequest('KPI endpoint requires an active organisation');
  return orgId;
}

export async function registerAureanRecruitmentKpiRoutes(app: FastifyInstance): Promise<void> {
  const reader = getPrismaReader();

  app.get('/aurean-recruitment/kpis', { preHandler: requireAuth }, async (req) => {
    const orgId = requireOrgScope(req.auth?.orgId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [placements, candidates, stageMoves, commissionAgg, clawbackAgg] = await Promise.all([
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.AUREAN_RECRUITMENT,
          eventType: 'placement.contracted',
          receivedAt: { gte: since },
        },
      }),
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.AUREAN_RECRUITMENT,
          eventType: 'candidate.entered_pipeline',
          receivedAt: { gte: since },
        },
      }),
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.AUREAN_RECRUITMENT,
          eventType: 'candidate.stage_changed',
          receivedAt: { gte: since },
        },
      }),
      reader.revenueEvent.aggregate({
        where: {
          orgId,
          source: WebhookSource.AUREAN_RECRUITMENT,
          eventType: 'COMMISSION',
          effectiveAt: { gte: since },
        },
        _sum: { amount: true },
      }),
      reader.revenueEvent.aggregate({
        where: {
          orgId,
          source: WebhookSource.AUREAN_RECRUITMENT,
          eventType: 'CLAWBACK',
          effectiveAt: { gte: since },
        },
        _sum: { amount: true },
      }),
    ]);

    const commission = commissionAgg._sum.amount?.toString() ?? '0';
    const clawback = clawbackAgg._sum.amount?.toString() ?? '0';
    return {
      window: '30d',
      candidatesEnteredPipeline: candidates,
      stageMoves,
      placementsContracted: placements,
      commissionAmount: commission,
      clawbackAmount: clawback,
    };
  });
}
