/**
 * Tags. Cross-resource organisation. A `Tag` is a name + color. A
 * `TagAssignment` attaches a tag to a (resource_type, resource_id) tuple.
 *
 * Endpoints support: list / create / delete tags; attach / detach on resources;
 * filter resources by tag (callers build the JOIN themselves via the assignments
 * list).
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { errors } from '../../shared/errors/app-error.js';

const COLORS = ['slate', 'blue', 'navy', 'red', 'amber', 'green', 'purple'] as const;
const ALLOWED_RESOURCES = [
  'customer',
  'partner',
  'application',
  'lender_decision',
  'case',
] as const;

const TagSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'lowercase, digits, dashes only'),
  color: z.enum(COLORS).default('slate'),
  description: z.string().max(200).optional(),
});

const AssignSchema = z.object({
  tagId: z.string().uuid(),
  resourceType: z.enum(ALLOWED_RESOURCES),
  resourceId: z.string().min(1),
});

export async function registerTagRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get('/tags', { preHandler: requireAuth }, async () => {
    const rows = await prisma.tag.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      description: t.description,
      assignmentCount: t._count.assignments,
      createdAt: t.createdAt.toISOString(),
    }));
  });

  app.post(
    '/tags',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const auth = req.auth!;
      const input = TagSchema.parse(req.body);
      // Phase 1 retrofit: tag names are unique per-org. Source orgId from
      // the authenticated principal; fall back to bootstrap during Phase 1.3
      // transition when session-only flows haven't yet been moved under
      // /o/:orgSlug/. Once Phase 1.3 lands the fallback is unreachable.
      const orgId = auth.orgId ?? (await getBootstrapOrgId(prisma));
      const exists = await prisma.tag.findUnique({
        where: { orgId_name: { orgId, name: input.name } },
      });
      if (exists) throw errors.conflict('Tag name already in use', { name: input.name });
      const created = await prisma.tag.create({
        data: {
          id: uuidv7(),
          orgId,
          name: input.name,
          color: input.color,
          description: input.description ?? null,
        },
      });
      reply.status(201);
      return { id: created.id, name: created.name, color: created.color };
    },
  );

  app.delete(
    '/tags/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const exists = await prisma.tag.findUnique({ where: { id } });
      if (!exists) throw errors.notFound('Tag', id);
      await prisma.$transaction(async (tx) => {
        await tx.tagAssignment.deleteMany({ where: { tagId: id } });
        await tx.tag.delete({ where: { id } });
      });
      reply.status(204).send();
    },
  );

  app.post(
    '/tag-assignments',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const auth = req.auth!;
      const input = AssignSchema.parse(req.body);
      const tag = await prisma.tag.findUnique({ where: { id: input.tagId } });
      if (!tag) throw errors.notFound('Tag', input.tagId);
      const existing = await prisma.tagAssignment.findUnique({
        where: {
          tagId_resourceType_resourceId: {
            tagId: input.tagId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
          },
        },
      });
      if (existing) {
        reply.status(200);
        return { id: existing.id, alreadyAssigned: true };
      }
      const created = await prisma.tagAssignment.create({
        data: {
          id: uuidv7(),
          // Inherit org from the parent tag — assignments are tenant-scoped
          // via the tag they reference.
          orgId: tag.orgId,
          tagId: input.tagId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          assignedBy: auth.userId,
        },
      });
      reply.status(201);
      return { id: created.id };
    },
  );

  app.delete(
    '/tag-assignments/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const exists = await prisma.tagAssignment.findUnique({ where: { id } });
      if (!exists) throw errors.notFound('TagAssignment', id);
      await prisma.tagAssignment.delete({ where: { id } });
      reply.status(204).send();
    },
  );

  // List tags assigned to a specific resource
  app.get('/tag-assignments', { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        resourceType: z.enum(ALLOWED_RESOURCES),
        resourceId: z.string().min(1),
      })
      .parse(req.query);
    const rows = await prisma.tagAssignment.findMany({
      where: { resourceType: q.resourceType, resourceId: q.resourceId },
      include: { tag: true, user: { select: { email: true } } },
      orderBy: { assignedAt: 'desc' },
    });
    return rows.map((a) => ({
      id: a.id,
      tag: { id: a.tag.id, name: a.tag.name, color: a.tag.color },
      assignedBy: a.user.email,
      assignedAt: a.assignedAt.toISOString(),
    }));
  });
}
