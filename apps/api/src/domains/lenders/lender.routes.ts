import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { LenderRepository } from './lender.repository.js';
import { LenderService } from './lender.service.js';
import { LenderRangeQuerySchema } from './lender.schemas.js';

export async function registerLenderRoutes(app: FastifyInstance): Promise<void> {
  const repo = new LenderRepository(getPrisma());
  const service = new LenderService(repo);

  app.get('/lenders/waterfall', { preHandler: requireAuth }, async (req) => {
    const query = LenderRangeQuerySchema.parse(req.query);
    return service.waterfall(query);
  });

  app.get('/lenders', { preHandler: requireAuth }, async () => {
    const rows = await getPrisma().lenderDecision.findMany({
      distinct: ['lenderName'],
      select: { lenderName: true, lenderTier: true },
      orderBy: { lenderName: 'asc' },
    });
    return rows;
  });

  app.get('/lenders/:name/performance', { preHandler: requireAuth }, async (req) => {
    const params = req.params as { name: string };
    const rows = await getPrisma().lenderDecision.findMany({
      where: { lenderName: params.name },
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
