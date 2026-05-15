/**
 * GET /api/v1/highsale/kpis  (GAP-105 KPI surface)
 *
 * Per-org HighSale business KPI snapshot. Inquiry + risk-band counts
 * from webhook events; revenue from the ledger; snapshot count from
 * credit_enrichments rows.
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

export async function registerHighSaleBusinessKpiRoutes(app: FastifyInstance): Promise<void> {
  const reader = getPrismaReader();

  app.get('/highsale/kpis', { preHandler: requireAuth }, async (req) => {
    const orgId = requireOrgScope(req.auth?.orgId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [inquiries, riskBands, snapshots, revenueAgg] = await Promise.all([
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.HIGHSALE,
          eventType: 'inquiry.submitted',
          receivedAt: { gte: since },
        },
      }),
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.HIGHSALE,
          eventType: 'risk_band.assigned',
          receivedAt: { gte: since },
        },
      }),
      reader.creditEnrichment.count({
        where: { orgId, pulledAt: { gte: since }, deletedAt: null },
      }),
      reader.revenueEvent.aggregate({
        where: { orgId, source: WebhookSource.HIGHSALE, effectiveAt: { gte: since } },
        _sum: { amount: true },
      }),
    ]);

    return {
      window: '30d',
      inquiries,
      riskBandsAssigned: riskBands,
      snapshotsGenerated: snapshots,
      revenueAmount: revenueAgg._sum.amount?.toString() ?? '0',
    };
  });
}
