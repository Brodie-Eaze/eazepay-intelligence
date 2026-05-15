import type { FastifyInstance } from 'fastify';
import { getPrismaReader } from '../../config/database.js';
import { errors } from '../../shared/errors/app-error.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { LenderRepository } from './lender.repository.js';
import { LenderService } from './lender.service.js';
import { LenderRangeQuerySchema } from './lender.schemas.js';

/** GAP-108: lender surfaces are org-scoped. */
function requireOrgScope(orgId: string | undefined): string {
  if (!orgId) throw errors.badRequest('Lender queries require an active organisation');
  return orgId;
}

export async function registerLenderRoutes(app: FastifyInstance): Promise<void> {
  const repo = new LenderRepository(getPrismaReader());
  const service = new LenderService(repo);

  app.get('/lenders/waterfall', { preHandler: requireAuth }, async (req) => {
    const query = LenderRangeQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    return service.waterfall(orgId, query);
  });

  app.get('/lenders', { preHandler: requireAuth }, async (req) => {
    const orgId = requireOrgScope(req.auth?.orgId);
    const rows = await getPrismaReader().lenderDecision.findMany({
      where: { orgId },
      distinct: ['lenderName'],
      select: { lenderName: true, lenderTier: true },
      orderBy: { lenderName: 'asc' },
    });
    return rows;
  });

  app.get('/lenders/:name/performance', { preHandler: requireAuth }, async (req) => {
    const params = req.params as { name: string };
    const orgId = requireOrgScope(req.auth?.orgId);
    const rows = await getPrismaReader().lenderDecision.findMany({
      where: { orgId, lenderName: params.name },
      orderBy: { decisionTimestamp: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      decisionTimestamp: r.decisionTimestamp.toISOString(),
      decision: r.decision,
      apr: r.apr?.toString() ?? null,
      approvalAmount: r.approvalAmount?.toString() ?? null,
      fundingStatus: r.fundingStatus,
      fundingAmount: r.fundingAmount?.toString() ?? null,
    }));
  });
}
