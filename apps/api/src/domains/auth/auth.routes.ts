import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import { getEnv } from '../../config/env.js';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { errors } from '../../shared/errors/app-error.js';
import { COOKIE, clearCookie, readCookie, setCookie } from '../../shared/utils/cookies.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { denyJti, denySession, requireAuth } from '../../shared/middleware/auth.middleware.js';
import {
  issueStepUpToken,
  STEP_UP_COOKIE_NAME,
  STEP_UP_TTL,
} from '../../shared/middleware/mfa-step-up.middleware.js';
import { verifyJwt } from '../../shared/utils/jwt.js';
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

  // CSRF on refresh: even though it's "just" reading the refresh cookie, the
  // rotation produces a fresh access cookie under the same identity. Without
  // the guard, SameSite=None means a malicious site can keep a stolen refresh
  // token alive indefinitely by silently refreshing it from any browser tab.
  app.post('/auth/refresh', { preHandler: csrfGuard }, async (req, reply) => {
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

    // Phase 4 (SEC-113): mark the in-flight access JWT's jti as revoked
    // until its natural expiry. Before this, the access cookie remained
    // valid for up to JWT_ACCESS_TTL_SECONDS (15min default) after logout
    // — a stolen access token via XSS/log-leak survived the user clicking
    // logout. We parse the access cookie here (best-effort; the cookie
    // may already be gone if cleared by an earlier flow) and add its jti
    // to the Redis deny-list.
    const accessRaw = readCookie(req, COOKIE.ACCESS);
    if (accessRaw) {
      try {
        const payload = verifyJwt(accessRaw, 'access');
        await denyJti(payload.jti, new Date(payload.exp * 1000));
      } catch {
        // Invalid / expired access cookie — nothing to deny.
      }
    }

    const userId = req.auth?.userId;
    clearCookie(reply, COOKIE.ACCESS);
    clearCookie(reply, COOKIE.REFRESH);
    clearCookie(reply, COOKIE.CSRF);
    if (userId) {
      await writeAuditLog({
        req,
        userId,
        action: 'USER_LOGOUT',
        resourceType: 'user',
        resourceId: userId,
      });
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

  // P0 fix (CR-106 + SEC-130): dedicated per-user rate limit on MFA-code
  // verification. The previous setup relied on the global per-user budget
  // (1000/min) which is wholly insufficient for a 6-digit TOTP code space
  // (10^6 possibilities → ~16 min to enumerate a single user's space). The
  // bucket below caps at 5 attempts per 90 seconds per user. Beyond that:
  // the composite rate limiter throws 429, the request never reaches the
  // verify call, and the audit log records `USER_MFA_RATE_LIMITED` so
  // brute-force attempts surface in monitoring.
  const mfaRateLimit = compositeRateLimit({
    prefix: 'auth:mfa',
    windowSeconds: 90,
    max: 5,
    keys: (req) => {
      // The MFA routes run after requireAuth so req.auth is populated.
      // Bucket on userId; never on IP, because a single user behind a
      // shared NAT shouldn't be locked out by another user's typing
      // mistakes.
      const userId = req.auth?.userId ?? 'anonymous';
      return [`user:${userId}`];
    },
  });

  const VerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });
  app.post(
    '/auth/mfa/verify',
    { preHandler: [requireAuth, csrfGuard, mfaRateLimit] },
    async (req) => {
      const auth = req.auth!;
      const { code } = VerifySchema.parse(req.body);
      const secret = await redis.get(`mfa:setup:${auth.userId}`);
      if (!secret) throw errors.badRequest('MFA setup not in progress');
      if (!authenticator.verify({ token: code, secret })) {
        // Surface the failed attempt before throwing so the audit trail
        // distinguishes "code typo" from "real attack" via volume.
        await writeAuditLog({
          req,
          userId: auth.userId,
          action: 'USER_MFA_FAILED',
          resourceType: 'user',
          resourceId: auth.userId,
        });
        throw errors.unauthorized('Invalid code');
      }
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
    },
  );

  app.post(
    '/auth/mfa/disable',
    { preHandler: [requireAuth, csrfGuard, mfaRateLimit] },
    async (req) => {
      const auth = req.auth!;
      const { code } = VerifySchema.parse(req.body);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (!user.mfaEnabled || !user.mfaSecret) throw errors.badRequest('MFA not enabled');
      if (!authenticator.verify({ token: code, secret: user.mfaSecret })) {
        await writeAuditLog({
          req,
          userId: auth.userId,
          action: 'USER_MFA_FAILED',
          resourceType: 'user',
          resourceId: auth.userId,
          metadata: { op: 'disable' },
        });
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
    },
  );

  // ─── Sessions (Phase 4c) ──────────────────────────────────────────────────
  //
  // /auth/sessions enumerates every active refresh-token session for the
  // user (one row per sessionId). /auth/sessions/:id DELETE revokes one,
  // writing the sessionId into a Redis deny-list keyed on `sid` so any
  // outstanding access tokens in that session are denied within one
  // request — no waiting 15 minutes for the access cookie to expire.
  app.get('/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const sessions = await service.listSessions(auth.userId);
    // Mark the "current" session so the UI can render it distinctly and
    // guard the user from revoking the session they're currently logged
    // in with. `sid` is populated on the AuthContext from the access JWT
    // claim by requireAuth.
    return {
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        orgId: s.orgId,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: auth.sid === s.sessionId,
      })),
    };
  });

  app.delete(
    '/auth/sessions/:sessionId',
    { preHandler: [requireAuth, csrfGuard] },
    async (req, reply) => {
      const auth = req.auth!;
      const params = z.object({ sessionId: z.string().uuid() }).parse(req.params);
      const count = await service.revokeSession(auth.userId, params.sessionId);
      if (count === 0) {
        // Either the sessionId belongs to a different user (don't leak),
        // or it was already revoked / expired. Same response either way.
        throw errors.notFound('Session not found');
      }
      // Deny the sessionId for the maximum access-token lifetime so any
      // outstanding access tokens in this session are rejected immediately.
      await denySession(params.sessionId, env.JWT_ACCESS_TTL_SECONDS);
      await writeAuditLog({
        req,
        userId: auth.userId,
        action: 'USER_SESSION_REVOKED',
        resourceType: 'session',
        resourceId: params.sessionId,
        metadata: { rowsRevoked: count },
      });
      reply.status(204).send();
    },
  );

  // ─── MFA step-up (Phase H) ───────────────────────────────────────────────
  //
  // Critical SUPER actions (cryptoshred, impersonate-token, DLQ replay,
  // tenant offboarding, quarantine replay) require a fresh MFA proof
  // on top of the session cookie. POST /auth/mfa/step-up/verify with a
  // current TOTP issues a single-use, 5-minute __Host-mfa_stepup cookie
  // that requireMfaStepUp() consumes.
  app.post(
    '/auth/mfa/step-up/verify',
    { preHandler: [requireAuth, csrfGuard] },
    async (req, reply) => {
      const auth = req.auth!;
      const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (!user.mfaEnabled || !user.mfaSecret) {
        throw errors.badRequest('MFA must be enabled before step-up is available');
      }
      if (!authenticator.verify({ token: body.code, secret: user.mfaSecret })) {
        await writeAuditLog({
          req,
          userId: user.id,
          action: 'USER_MFA_FAILED',
          resourceType: 'user',
          resourceId: user.id,
          metadata: { surface: 'step_up' },
        });
        throw errors.unauthorized('Invalid MFA code');
      }
      const { token, expiresAt } = issueStepUpToken(user.id);
      setCookie(reply, STEP_UP_COOKIE_NAME, token, {
        maxAgeSeconds: STEP_UP_TTL,
        httpOnly: true,
      });
      await writeAuditLog({
        req,
        userId: user.id,
        action: 'USER_MFA_ENABLED',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { surface: 'step_up.issued' },
      });
      return { token, expiresAt: expiresAt.toISOString() };
    },
  );

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
    setCookie(reply, COOKIE.ACCESS, issued.access.token, {
      maxAgeSeconds: accessTtl,
      httpOnly: true,
    });
    setCookie(reply, COOKIE.REFRESH, issued.refresh.token, {
      maxAgeSeconds: refreshTtl,
      httpOnly: true,
    });
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
