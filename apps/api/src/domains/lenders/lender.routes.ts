import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma, getPrismaReader } from '../../config/database.js';
import { errors } from '../../shared/errors/app-error.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { LenderRepository } from './lender.repository.js';
import { LenderService } from './lender.service.js';
import { LenderRangeQuerySchema } from './lender.schemas.js';
import { LenderSubmissionService } from './lender-submission.service.js';
import { listLenderAdapters } from './adapter/lender-adapter-registry.js';

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

  // GAP-101: registered lender adapters surface.
  app.get('/lenders/adapters', { preHandler: requireAuth }, async () => {
    return listLenderAdapters().map((a) => ({
      slug: a.slug,
      displayName: a.displayName,
      tier: a.tier,
      ready: a.isReady(),
    }));
  });

  // GAP-101: submit an application to a specific lender. Admin/Operator-
  // only; CSRF-guarded.
  app.post(
    '/lenders/submit',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const body = z
        .object({
          applicationId: z.string().uuid(),
          lenderSlug: z.string().min(1).max(64),
          requestedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        })
        .parse(req.body);
      const orgId = req.auth?.orgId;
      if (!orgId) throw errors.badRequest('Active organisation required');
      const svc = new LenderSubmissionService(getPrisma());
      const decision = await svc.submitToLender(body);
      reply.status(202);
      return {
        decisionId: decision.id,
        externalDecisionId: decision.externalDecisionId,
        lenderName: decision.lenderName,
        decision: decision.decision,
      };
    },
  );

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
