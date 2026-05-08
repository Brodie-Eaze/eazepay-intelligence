/**
 * Invitation surfaces.
 *
 *   ADMIN-only:
 *     POST   /users/invitations          issue
 *     GET    /users/invitations          list pending
 *     DELETE /users/invitations/:id      revoke
 *
 *   PUBLIC (token-gated):
 *     GET    /auth/invitations/:token              preview email/role
 *     POST   /auth/invitations/:token/accept       set password, sign in
 *
 * The "accept" endpoint issues a session immediately so the user lands
 * authenticated rather than bouncing through /auth/login. Same cookie
 * shape as login.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { InvitationService } from './invitation.service.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { AuthService } from '../auth/auth.service.js';
import { COOKIE, setCookie } from '../../shared/utils/cookies.js';
import { UserResponseSchema } from '../auth/auth.schemas.js';

const Role = z.enum(['ADMIN', 'OPERATOR', 'INVESTOR', 'VIEWER']);

const IssueSchema = z.object({
  email: z.string().email().toLowerCase(),
  role: Role.default('VIEWER'),
});

const AcceptSchema = z.object({
  password: z.string().min(8).max(128),
});

export async function registerInvitationRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();
  const invites = new InvitationService(prisma);
  const authService = new AuthService(new AuthRepository(prisma), redis);

  // ─── Admin surfaces ──────────────────────────────────────────────────────

  app.post(
    '/users/invitations',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const body = IssueSchema.parse(req.body);
      const auth = req.auth!;
      // Phase 1.2a transitional: org context is not yet on req.auth (that
      // arrives in Phase 1.3). Resolve from the issuer's first membership.
      // Once Phase 1.3 lands, this becomes `auth.orgId`.
      const issuerMembership = await prisma.membership.findFirst({
        where: { userId: auth.userId },
        orderBy: { createdAt: 'asc' },
      });
      if (!issuerMembership) {
        throw new Error('Issuer has no organisation membership');
      }
      const result = await invites.issue({
        email: body.email,
        role: body.role,
        invitedById: auth.userId,
        orgId: issuerMembership.orgId,
      });
      await writeAuditLog({
        req,
        action: 'USER_INVITED',
        resourceType: 'user_invitation',
        resourceId: result.id,
        metadata: { email: result.email, role: result.role, emailDelivered: result.emailDelivered },
      });
      reply.status(201);
      return {
        id: result.id,
        email: result.email,
        role: result.role,
        expiresAt: result.expiresAt.toISOString(),
        emailDelivered: result.emailDelivered,
        // Returned to admin so they can copy the link if email failed.
        // Not logged. Treat as a short-lived secret.
        acceptUrl: result.acceptUrl,
      };
    },
  );

  app.get('/users/invitations', { preHandler: [requireAuth, requireRole('ADMIN')] }, async () => {
    const list = await invites.list();
    return list.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    }));
  });

  app.delete(
    '/users/invitations/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await invites.revoke(id);
      await writeAuditLog({
        req,
        action: 'USER_INVITATION_REVOKED',
        resourceType: 'user_invitation',
        resourceId: id,
      });
      reply.status(204).send();
    },
  );

  // ─── Public token-gated surfaces ─────────────────────────────────────────

  app.get('/auth/invitations/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(16).max(256) }).parse(req.params);
    const preview = await invites.preview(token);
    return {
      email: preview.email,
      role: preview.role,
      expiresAt: preview.expiresAt.toISOString(),
    };
  });

  app.post('/auth/invitations/:token/accept', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(16).max(256) }).parse(req.params);
    const body = AcceptSchema.parse(req.body);
    const { userId } = await invites.accept({ rawToken: token, password: body.password });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const issued = await authService.issueSessionForUser(user, 'standard');

    // Same cookie protocol as /auth/login.
    const accessTtl = Math.floor((issued.access.expiresAt.getTime() - Date.now()) / 1000);
    const refreshTtl = Math.floor((issued.refresh.expiresAt.getTime() - Date.now()) / 1000);
    setCookie(reply, COOKIE.ACCESS, issued.access.token, {
      maxAgeSeconds: accessTtl,
      httpOnly: true,
    });
    setCookie(reply, COOKIE.REFRESH, issued.refresh.token, {
      maxAgeSeconds: refreshTtl,
      httpOnly: true,
    });
    setCookie(reply, COOKIE.CSRF, issued.csrf, { maxAgeSeconds: accessTtl, httpOnly: false });

    await writeAuditLog({
      req,
      userId,
      action: 'USER_INVITATION_ACCEPTED',
      resourceType: 'user',
      resourceId: userId,
      metadata: { email: user.email, role: user.role },
    });

    return {
      user: UserResponseSchema.parse({
        id: user.id,
        email: user.email,
        role: user.role,
        scope: issued.scope,
        mfaEnabled: user.mfaEnabled,
      }),
      csrfToken: issued.csrf,
      accessTokenExpiresAt: issued.access.expiresAt.toISOString(),
    };
  });
}
