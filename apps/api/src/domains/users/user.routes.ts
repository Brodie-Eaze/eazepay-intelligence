import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { hashPassword } from '../../shared/utils/password.js';
import { errors } from '../../shared/errors/app-error.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';

const Role = z.enum(['ADMIN', 'OPERATOR', 'INVESTOR', 'VIEWER']);

const CreateUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
  role: Role.default('VIEWER'),
});

const UpdateUserSchema = z.object({
  role: Role.optional(),
  password: z.string().min(8).max(128).optional(),
});

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get('/users', { preHandler: [requireAuth, requireRole('ADMIN')] }, async () => {
    const rows = await prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { refreshTokens: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } },
        },
      },
    });
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      mfaEnabled: u.mfaEnabled,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      activeSessions: u._count.refreshTokens,
    }));
  });

  app.post(
    '/users',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const input = CreateUserSchema.parse(req.body);
      const exists = await prisma.user.findUnique({ where: { email: input.email } });
      if (exists) throw errors.conflict('Email already in use', { email: input.email });
      const passwordHash = await hashPassword(input.password);
      // SOC2 CC6-021: provisioning a user (incl. role assignment) and the
      // audit row run in one tx so we never have a real user without a
      // creation-event row.
      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { id: uuidv7(), email: input.email, passwordHash, role: input.role },
        });
        await writeAuditLog({
          req,
          tx,
          action: 'USER_CREATED',
          resourceType: 'user',
          resourceId: u.id,
          metadata: { email: u.email, role: u.role },
        });
        return u;
      });
      reply.status(201);
      return {
        id: created.id,
        email: created.email,
        role: created.role,
        mfaEnabled: created.mfaEnabled,
        createdAt: created.createdAt.toISOString(),
      };
    },
  );

  app.patch(
    '/users/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const input = UpdateUserSchema.parse(req.body);
      const data: Prisma.UserUpdateInput = {};
      if (input.role !== undefined) data.role = input.role;
      if (input.password !== undefined) data.passwordHash = await hashPassword(input.password);
      // SOC2 CC6-021: role / password changes and their audit row commit
      // together. ECOA / FCRA care about a complete history of role
      // changes; the audit row is the source of truth for access reviews.
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({ where: { id }, data });
        await writeAuditLog({
          req,
          tx,
          action: 'USER_UPDATED',
          resourceType: 'user',
          resourceId: u.id,
          metadata: { fields: Object.keys(input) },
        });
        return u;
      });
      return { id: updated.id, email: updated.email, role: updated.role };
    },
  );

  app.delete(
    '/users/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const auth = req.auth!;
      if (auth.userId === id) throw errors.badRequest('Cannot delete your own account');
      // SOC2 CC6-021: soft-delete + session revocation + audit row are now
      // a single atomic unit. Previously the audit insert lived outside
      // the tx so a crash between commit and the audit insert left a
      // deleted user with no termination event.
      await prisma.$transaction(async (tx) => {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.user.update({ where: { id }, data: { deletedAt: new Date() } });
        await writeAuditLog({
          req,
          tx,
          action: 'USER_DELETED',
          resourceType: 'user',
          resourceId: id,
        });
      });
      reply.status(204).send();
    },
  );
}
