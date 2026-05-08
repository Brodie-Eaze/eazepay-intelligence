/**
 * Personal Access Tokens.
 *
 * Each user manages their own. Token is shown ONCE on creation; after that
 * only the prefix and last-used metadata are visible.
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { generateApiToken } from '../../shared/utils/api-token.js';
import { errors } from '../../shared/errors/app-error.js';

const Scope = z.enum(['READ', 'WRITE', 'ADMIN']);

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(Scope).min(1),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export async function registerApiTokenRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get('/api-tokens', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const rows = await prisma.apiToken.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null,
      revokedAt: t.revokedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      isActive: !t.revokedAt && (!t.expiresAt || t.expiresAt.getTime() > Date.now()),
    }));
  });

  app.post('/api-tokens', { preHandler: [requireAuth, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const input = CreateSchema.parse(req.body);
    const { token, prefix, hashedSecret } = generateApiToken();
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;
    // Phase 1.3: orgId is in the JWT after login. Fallback to membership
    // lookup for tokens minted before the embed change.
    let orgId = auth.orgId;
    if (!orgId) {
      const fallback = await prisma.membership.findFirst({
        where: { userId: auth.userId },
        orderBy: { createdAt: 'asc' },
        select: { orgId: true },
      });
      if (!fallback) throw new Error('Issuer has no organisation membership');
      orgId = fallback.orgId;
    }
    const created = await prisma.apiToken.create({
      data: {
        id: uuidv7(),
        userId: auth.userId,
        orgId,
        name: input.name,
        prefix,
        hashedSecret,
        scopes: input.scopes,
        expiresAt,
      },
    });
    await writeAuditLog({
      req,
      action: 'USER_UPDATED',
      resourceType: 'api_token',
      resourceId: created.id,
      metadata: {
        name: input.name,
        scopes: input.scopes,
        expiresInDays: input.expiresInDays ?? null,
      },
    });
    reply.status(201);
    return {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt?.toISOString() ?? null,
      createdAt: created.createdAt.toISOString(),
      // Returned ONCE — never again
      token,
    };
  });

  app.delete('/api-tokens/:id', { preHandler: [requireAuth, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await prisma.apiToken.findUnique({ where: { id } });
    if (!row || row.userId !== auth.userId) throw errors.notFound('ApiToken', id);
    if (row.revokedAt) throw errors.badRequest('Already revoked');
    await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAuditLog({
      req,
      action: 'USER_UPDATED',
      resourceType: 'api_token',
      resourceId: id,
      metadata: { revoked: true },
    });
    reply.status(204).send();
  });
}
