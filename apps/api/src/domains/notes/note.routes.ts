/**
 * Notes attached to a resource. Operators leave context for the next person.
 *
 * Resource types: 'customer' (email_hash hex), 'partner', 'application',
 * 'lender_decision', 'case'. Validation is light — we don't want a static enum
 * to lock us out of new resource types as the system grows.
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { errors } from '../../shared/errors/app-error.js';

const ALLOWED = ['customer', 'partner', 'application', 'lender_decision', 'case'] as const;

const ListQuery = z.object({
  resourceType: z.enum(ALLOWED),
  resourceId: z.string().min(1),
});

const CreateSchema = z.object({
  resourceType: z.enum(ALLOWED),
  resourceId: z.string().min(1),
  body: z.string().min(1).max(4000),
  pinned: z.boolean().default(false),
});

const UpdateSchema = z.object({
  body: z.string().min(1).max(4000).optional(),
  pinned: z.boolean().optional(),
});

export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get('/notes', { preHandler: requireAuth }, async (req) => {
    const q = ListQuery.parse(req.query);
    const rows = await prisma.note.findMany({
      where: { resourceType: q.resourceType, resourceId: q.resourceId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: { author: { select: { email: true, role: true } } },
    });
    return rows.map((n) => ({
      id: n.id,
      body: n.body,
      pinned: n.pinned,
      authorEmail: n.author.email,
      authorRole: n.author.role,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    }));
  });

  app.post(
    '/notes',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const auth = req.auth!;
      const input = CreateSchema.parse(req.body);
      // Phase 1 retrofit: notes are tenant-scoped to prevent cross-org
      // visibility when a user holds memberships in multiple orgs.
      const orgId = auth.orgId ?? (await getBootstrapOrgId(prisma));
      const created = await prisma.note.create({
        data: {
          id: uuidv7(),
          orgId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          authorUserId: auth.userId,
          body: input.body,
          pinned: input.pinned,
        },
      });
      await writeAuditLog({
        req,
        action: 'USER_UPDATED',
        resourceType: 'note',
        resourceId: created.id,
        metadata: { onResource: input.resourceType, onResourceId: input.resourceId },
      });
      reply.status(201);
      return { id: created.id };
    },
  );

  app.patch(
    '/notes/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const input = UpdateSchema.parse(req.body);
      const existing = await prisma.note.findUnique({ where: { id } });
      if (!existing) throw errors.notFound('Note', id);
      if (existing.authorUserId !== auth.userId && auth.role !== 'ADMIN') {
        throw errors.forbidden('Only the author or an admin can edit this note');
      }
      const updated = await prisma.note.update({
        where: { id },
        data: { body: input.body ?? undefined, pinned: input.pinned ?? undefined },
      });
      return { id: updated.id, body: updated.body, pinned: updated.pinned };
    },
  );

  app.delete(
    '/notes/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const existing = await prisma.note.findUnique({ where: { id } });
      if (!existing) throw errors.notFound('Note', id);
      if (existing.authorUserId !== auth.userId && auth.role !== 'ADMIN') {
        throw errors.forbidden('Only the author or an admin can delete this note');
      }
      await prisma.note.delete({ where: { id } });
      reply.status(204).send();
    },
  );
}
