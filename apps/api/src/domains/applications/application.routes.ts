import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma, getPrismaReader } from '../../config/database.js';
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
  // Read-replica for the list/get queries; writer (primary) for decrypt
  // dispatch because decryptEnvelopeAuto needs to look up TenantEncryptionKey
  // rows. Reader may lag for fresh DEK rotations, so we use the writer.
  const prismaReader = getPrismaReader();
  const prisma = getPrisma();
  const repo = new ApplicationRepository(prismaReader);
  const service = new ApplicationService(repo);

  // List — operators+ in standard scope; investor scope is forbidden (route hidden).
  app.get('/applications', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const query = ListApplicationsQuerySchema.parse(req.query);
    const page = await service.list(query);
    const data = await Promise.all(page.data.map((a) => toApplicationResponse(a, prisma)));
    return {
      data,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });

  app.get('/applications/:id', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const a = await service.getById(id);
    const decisions = await prismaReader.lenderDecision.findMany({
      where: { applicationId: id },
      orderBy: { decisionTimestamp: 'desc' },
    });
    return {
      application: await toApplicationResponse(a, prisma),
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
        pii = await decryptApplicationPii(a, prisma);
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
