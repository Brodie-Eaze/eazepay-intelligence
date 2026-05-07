import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrismaReader } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { denyInvestorScope, requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { ApplicationRepository } from './application.repository.js';
import { ApplicationService } from './application.service.js';
import { ListApplicationsQuerySchema } from './application.schemas.js';
import { decryptApplicationPii, toApplicationResponse } from './application.types.js';

const IdParamSchema = z.object({ id: z.string().uuid() });

export async function registerApplicationRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrismaReader();
  const repo = new ApplicationRepository(prisma);
  const service = new ApplicationService(repo);

  // List — operators+ in standard scope; investor scope is forbidden (route hidden).
  app.get('/applications', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const query = ListApplicationsQuerySchema.parse(req.query);
    const page = await service.list(query);
    return {
      data: page.data.map(toApplicationResponse),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });

  app.get('/applications/:id', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const a = await service.getById(id);
    const decisions = await prisma.lenderDecision.findMany({
      where: { applicationId: id },
      orderBy: { decisionTimestamp: 'desc' },
    });
    return {
      application: toApplicationResponse(a),
      decisions: decisions.map((d) => ({
        id: d.id,
        lenderName: d.lenderName,
        lenderTier: d.lenderTier,
        decision: d.decision,
        decisionTimestamp: d.decisionTimestamp.toISOString(),
        approvalAmount: d.approvalAmount?.toString() ?? null,
        apr: d.apr?.toString() ?? null,
        term: d.term,
        fundingStatus: d.fundingStatus,
        fundingAmount: d.fundingAmount?.toString() ?? null,
        fundingTimestamp: d.fundingTimestamp?.toISOString() ?? null,
      })),
    };
  });

  // PII reveal — admin/operator only, audit-logged. Never available in investor scope.
  app.get(
    '/applications/:id/pii',
    {
      preHandler: [requireAuth, denyInvestorScope, csrfGuard, requireRole('ADMIN', 'OPERATOR')],
    },
    async (req) => {
      const { id } = IdParamSchema.parse(req.params);
      const a = await service.getById(id);
      let pii;
      try {
        pii = decryptApplicationPii(a);
      } catch {
        throw errors.internal('PII decryption failed');
      }
      await writeAuditLog({
        req,
        action: 'PII_ACCESSED',
        resourceType: 'application',
        resourceId: id,
        metadata: { fields: ['name', 'email', 'phone'] },
      });
      return {
        id: a.id,
        consumerName: pii.name,
        consumerEmail: pii.email,
        consumerPhone: pii.phone,
      };
    },
  );
}
