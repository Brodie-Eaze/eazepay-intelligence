/**
 * GET /api/v1/aurean-ai/kpis  (GAP-103 KPI surface)
 *
 * Per-org Aurean AI KPI snapshot. Sourced from the revenue ledger
 * (RevenueStream.AUREAN_AI) + the webhook event stream for inference
 * counts. Org-scoped via req.auth.orgId.
 *
 * Returns:
 *   {
 *     window: '7d',
 *     inferenceRuns: number,
 *     scoresPublished: number,
 *     revenueAmount: string,
 *     lastInferenceAt: ISO | null
 *   }
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

export async function registerAureanAiKpiRoutes(app: FastifyInstance): Promise<void> {
  const reader = getPrismaReader();

  app.get('/aurean-ai/kpis', { preHandler: requireAuth }, async (req) => {
    const orgId = requireOrgScope(req.auth?.orgId);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [revenueAgg, inferenceRuns, scoresPublished, lastInference] = await Promise.all([
      reader.revenueEvent.aggregate({
        where: { orgId, source: WebhookSource.AUREAN_AI, effectiveAt: { gte: since } },
        _sum: { amount: true },
      }),
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.AUREAN_AI,
          eventType: 'inference.completed',
          receivedAt: { gte: since },
        },
      }),
      reader.webhookEvent.count({
        where: {
          orgId,
          source: WebhookSource.AUREAN_AI,
          eventType: 'score.published',
          receivedAt: { gte: since },
        },
      }),
      reader.webhookEvent.findFirst({
        where: { orgId, source: WebhookSource.AUREAN_AI, eventType: 'inference.completed' },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true },
      }),
    ]);

    return {
      window: '7d',
      inferenceRuns,
      scoresPublished,
      revenueAmount: revenueAgg._sum.amount?.toString() ?? '0',
      lastInferenceAt: lastInference?.receivedAt.toISOString() ?? null,
    };
  });
}
