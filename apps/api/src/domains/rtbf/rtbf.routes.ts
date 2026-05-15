/**
 * RTBF (right-to-be-forgotten) admin endpoints.
 *
 * POST /admin/rtbf            — submit a new request (admin-only, CSRF-guarded)
 * GET  /admin/rtbf            — list requests
 * POST /admin/rtbf/:id/process — process a PENDING request synchronously
 *                                (small N — usually 1–5 apps per subject)
 *
 * For larger backfills the lifecycle worker drains PENDING rows on its
 * schedule. The `:id/process` endpoint is the manual trigger ops uses
 * during the 30-day fulfilment window when speed matters.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrismaWriter } from '../../config/database.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { hashPII } from '../../shared/utils/encryption.js';
import { errors } from '../../shared/errors/app-error.js';
import { RtbfService } from './rtbf.service.js';

const SubmitBody = z
  .object({
    // Either supply the email (we'll hash it) OR the precomputed hash.
    email: z.string().email().optional(),
    emailHashHex: z
      .string()
      .regex(/^[0-9a-f]+$/i)
      .optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((b) => b.email || b.emailHashHex, {
    message: 'Either `email` or `emailHashHex` is required',
  });

const ListQuery = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ProcessParam = z.object({ id: z.string().uuid() });

export async function registerRtbfRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrismaWriter();
  const service = new RtbfService(prisma);

  app.post(
    '/admin/rtbf',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const body = SubmitBody.parse(req.body);
      const emailHash = body.email
        ? hashPII(body.email.toLowerCase().trim())
        : Buffer.from(body.emailHashHex!, 'hex');
      if (emailHash.length !== 32) {
        throw errors.badRequest('emailHashHex must decode to 32 bytes (HMAC-SHA-256 output)');
      }
      const orgId = req.auth!.orgId ?? (await getBootstrapOrgId(prisma));
      const created = await service.submit({
        orgId,
        emailHash,
        requestedById: req.auth!.userId,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      reply.status(201);
      return created;
    },
  );

  app.get('/admin/rtbf', { preHandler: [requireAuth, requireRole('ADMIN')] }, async (req) => {
    const q = ListQuery.parse(req.query);
    return service.list({
      ...(q.status ? { status: q.status } : {}),
      limit: q.limit,
    });
  });

  app.post(
    '/admin/rtbf/:id/process',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const { id } = ProcessParam.parse(req.params);
      return service.process(id);
    },
  );
}
