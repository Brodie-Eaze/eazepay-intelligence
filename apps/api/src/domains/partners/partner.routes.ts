import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { PartnerRepository } from './partner.repository.js';
import { PartnerService } from './partner.service.js';
import {
  CreatePartnerSchema,
  ListPartnersQuerySchema,
  UpdatePartnerSchema,
} from './partner.schemas.js';
import { toPartnerInvestorResponse, toPartnerResponse } from './partner.types.js';

const IdParamSchema = z.object({ id: z.string().uuid() });

export async function registerPartnerRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const repo = new PartnerRepository(prisma);
  const service = new PartnerService(repo);

  app.get('/partners', { preHandler: requireAuth }, async (req) => {
    const query = ListPartnersQuerySchema.parse(req.query);
    const page = await service.list(query);
    const isInvestor = req.auth!.scope === 'investor';
    return {
      data: isInvestor
        ? page.data.map((p) => toPartnerInvestorResponse(p))
        : page.data.map((p) => toPartnerResponse(p)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });

  app.post(
    '/partners',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const input = CreatePartnerSchema.parse(req.body);
      const partner = await service.create(input);
      await writeAuditLog({
        req,
        action: 'PARTNER_CREATED',
        resourceType: 'partner',
        resourceId: partner.id,
        metadata: { externalId: partner.externalId, tier: partner.tier },
      });
      reply.status(201);
      return toPartnerResponse(partner);
    },
  );

  app.get('/partners/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const partner = await service.getById(id);
    return req.auth!.scope === 'investor'
      ? toPartnerInvestorResponse(partner)
      : toPartnerResponse(partner);
  });

  app.patch(
    '/partners/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const { id } = IdParamSchema.parse(req.params);
      const input = UpdatePartnerSchema.parse(req.body);
      const partner = await service.update(id, input);
      await writeAuditLog({
        req,
        action: 'PARTNER_UPDATED',
        resourceType: 'partner',
        resourceId: partner.id,
        metadata: { fields: Object.keys(input) },
      });
      return toPartnerResponse(partner);
    },
  );

  app.delete(
    '/partners/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const { id } = IdParamSchema.parse(req.params);
      await service.softDelete(id);
      await writeAuditLog({
        req,
        action: 'PARTNER_DELETED',
        resourceType: 'partner',
        resourceId: id,
      });
      reply.status(204).send();
    },
  );

  app.get('/partners/:id/performance', { preHandler: requireAuth }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const partner = await service.getById(id);
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [appCount, decisionCount, fundedCount, revenueAgg] = await Promise.all([
      prisma.application.count({ where: { partnerId: id, createdAt: { gte: since } } }),
      prisma.lenderDecision.count({ where: { partnerId: id, createdAt: { gte: since } } }),
      prisma.lenderDecision.count({
        where: { partnerId: id, fundingStatus: 'FUNDED', fundingTimestamp: { gte: since } },
      }),
      prisma.revenueEvent.aggregate({
        where: { partnerId: id, effectiveAt: { gte: since } },
        _sum: { amount: true },
      }),
    ]);
    const isInvestor = req.auth!.scope === 'investor';
    return {
      partner: isInvestor ? toPartnerInvestorResponse(partner) : toPartnerResponse(partner),
      window: { from: since.toISOString(), to: new Date().toISOString() },
      metrics: {
        applications: appCount,
        decisions: decisionCount,
        fundings: fundedCount,
        revenueTotal: (revenueAgg._sum.amount ?? '0').toString(),
      },
    };
  });
}
