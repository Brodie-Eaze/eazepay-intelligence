import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import { getEnv } from '../../config/env.js';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { errors } from '../../shared/errors/app-error.js';
import { COOKIE, clearCookie, readCookie, setCookie } from '../../shared/utils/cookies.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { compositeRateLimit } from '../../shared/middleware/rate-limit.middleware.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import {
  LoginRequestSchema,
  ScopeRequestSchema,
  type SessionResponse,
  UserResponseSchema,
} from './auth.schemas.js';
import type { IssuedTokens } from './auth.service.js';
import { z } from 'zod';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();
  const prisma = getPrisma();
  const redis = getRedis();
  const repo = new AuthRepository(prisma);
  const service = new AuthService(repo, redis);

  const loginRateLimit = compositeRateLimit({
    prefix: 'auth:login',
    windowSeconds: 300,
    max: 10,
    keys: (req) => {
      const body = (req.body ?? {}) as { email?: string };
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : 'unknown';
      return [`ip:${req.ip}`, `email:${email}`];
    },
  });

  app.post('/auth/login', { preHandler: loginRateLimit }, async (req, reply) => {
    const body = LoginRequestSchema.parse(req.body);
    try {
      const issued = await service.login(body);
      writeAuthCookies(reply, issued);
      await writeAuditLog({
        req,
        userId: issued.user.id,
        action: 'USER_LOGIN',
        resourceType: 'user',
        resourceId: issued.user.id,
      });
      return sessionResponse(issued);
    } catch (err) {
      await writeAuditLog({
        req,
        userId: null,
        action: 'USER_LOGIN_FAILED',
        resourceType: 'user',
        metadata: { email: body.email },
      });
      throw err;
    }
  });

  app.post('/auth/refresh', async (req, reply) => {
    const raw = readCookie(req, COOKIE.REFRESH);
    if (!raw) throw errors.unauthorized('Missing refresh cookie');
    const issued = await service.refresh(raw);
    writeAuthCookies(reply, issued);
    await writeAuditLog({
      req,
      userId: issued.user.id,
      action: 'USER_REFRESHED',
      resourceType: 'user',
      resourceId: issued.user.id,
    });
    return sessionResponse(issued);
  });

  app.post('/auth/logout', { preHandler: csrfGuard }, async (req, reply) => {
    const raw = readCookie(req, COOKIE.REFRESH);
    await service.logout(raw);
    const userId = req.auth?.userId;
    clearCookie(reply, COOKIE.ACCESS);
    clearCookie(reply, COOKIE.REFRESH);
    clearCookie(reply, COOKIE.CSRF);
    if (userId) {
      await writeAuditLog({ req, userId, action: 'USER_LOGOUT', resourceType: 'user', resourceId: userId });
    }
    reply.status(204).send();
  });

  app.post('/auth/scope', { preHandler: [requireAuth, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const body = ScopeRequestSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const issued = await service.toggleScope(user, body.scope);
    writeAuthCookies(reply, issued);
    await writeAuditLog({
      req,
      userId: user.id,
      action: 'USER_SCOPE_CHANGED',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { from: auth.scope, to: body.scope },
    });
    return sessionResponse(issued);
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    return UserResponseSchema.parse({
      id: user.id,
      email: user.email,
      role: user.role,
      scope: auth.scope,
      mfaEnabled: user.mfaEnabled,
    });
  });

  // ─── MFA ──────────────────────────────────────────────────────────────────
  app.post('/auth/mfa/setup', { preHandler: [requireAuth, csrfGuard] }, async (req) => {
    const auth = req.auth!;
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(auth.email, 'EazePay Intelligence', secret);
    // Stored unconfirmed until /verify; user must enter a valid code to enable.
    await redis.setex(`mfa:setup:${auth.userId}`, 600, secret);
    return { otpauthUrl, secretBase32: secret };
  });

  const VerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });
  app.post('/auth/mfa/verify', { preHandler: [requireAuth, csrfGuard] }, async (req) => {
    const auth = req.auth!;
    const { code } = VerifySchema.parse(req.body);
    const secret = await redis.get(`mfa:setup:${auth.userId}`);
    if (!secret) throw errors.badRequest('MFA setup not in progress');
    if (!authenticator.verify({ token: code, secret })) throw errors.unauthorized('Invalid code');
    await prisma.user.update({
      where: { id: auth.userId },
      data: { mfaEnabled: true, mfaSecret: secret },
    });
    await redis.del(`mfa:setup:${auth.userId}`);
    await writeAuditLog({
      req,
      userId: auth.userId,
      action: 'USER_MFA_ENABLED',
      resourceType: 'user',
      resourceId: auth.userId,
    });
    return { ok: true };
  });

  app.post('/auth/mfa/disable', { preHandler: [requireAuth, csrfGuard] }, async (req) => {
    const auth = req.auth!;
    const { code } = VerifySchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaEnabled || !user.mfaSecret) throw errors.badRequest('MFA not enabled');
    if (!authenticator.verify({ token: code, secret: user.mfaSecret })) {
      throw errors.unauthorized('Invalid code');
    }
    await prisma.user.update({
      where: { id: auth.userId },
      data: { mfaEnabled: false, mfaSecret: null },
    });
    await writeAuditLog({
      req,
      userId: auth.userId,
      action: 'USER_MFA_DISABLED',
      resourceType: 'user',
      resourceId: auth.userId,
    });
    return { ok: true };
  });

  // ─── WS Ticket ────────────────────────────────────────────────────────────
  app.post('/auth/ws/ticket', { preHandler: [requireAuth, csrfGuard] }, async (req) => {
    const auth = req.auth!;
    const issued = await service.issueWsTicket(auth.userId, auth.scope);
    await writeAuditLog({
      req,
      userId: auth.userId,
      action: 'WS_TICKET_ISSUED',
      resourceType: 'ws_ticket',
      metadata: { scope: auth.scope },
    });
    return issued;
  });

  // ─── helpers ──────────────────────────────────────────────────────────────
  function writeAuthCookies(reply: Parameters<typeof setCookie>[0], issued: IssuedTokens): void {
    const accessTtl = Math.floor((issued.access.expiresAt.getTime() - Date.now()) / 1000);
    const refreshTtl = Math.floor((issued.refresh.expiresAt.getTime() - Date.now()) / 1000);
    setCookie(reply, COOKIE.ACCESS, issued.access.token, { maxAgeSeconds: accessTtl, httpOnly: true });
    setCookie(reply, COOKIE.REFRESH, issued.refresh.token, { maxAgeSeconds: refreshTtl, httpOnly: true });
    setCookie(reply, COOKIE.CSRF, issued.csrf, { maxAgeSeconds: accessTtl, httpOnly: false });
  }

  function sessionResponse(issued: IssuedTokens): SessionResponse {
    return {
      user: UserResponseSchema.parse({
        id: issued.user.id,
        email: issued.user.email,
        role: issued.user.role,
        scope: issued.scope,
        mfaEnabled: issued.user.mfaEnabled,
      }),
      csrfToken: issued.csrf,
      accessTokenExpiresAt: issued.access.expiresAt.toISOString(),
    };
  }
}
