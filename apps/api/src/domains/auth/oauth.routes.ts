/**
 * Google OAuth 2.0 sign-in.
 *
 * Flow:
 *   GET /auth/oauth/google/start
 *     → 302 to Google's consent screen, with a signed `state` cookie that
 *       binds the request to a CSRF/replay nonce.
 *   GET /auth/oauth/google/callback?code=...&state=...
 *     → exchange code for tokens, validate id_token's signature & claims,
 *       match (or refuse to match) an existing User row, issue a session.
 *
 * Security model:
 *   - We do NOT auto-create users. OAuth is sign-in only; the inviter still
 *     adds the email via /users/invitations. Why: an OAuth-only world lets
 *     anyone with a Google account claim a seat by guessing the URL. Tying
 *     OAuth to an invited email keeps the gate where ADMIN wants it.
 *   - First successful Google login on an existing email row stores the
 *     `sub` (subject id). Future logins match on `sub`, not email — so a
 *     compromised email can't redirect a Google session to a different
 *     account.
 *   - GOOGLE_OAUTH_ALLOWED_DOMAINS, when set, hard-blocks any email outside
 *     the listed domains. Defence-in-depth on top of Google's own hd claim.
 *   - The `state` cookie carries a random 24-byte nonce + an HMAC over it.
 *     Verified on callback to prevent CSRF token-injection.
 *
 * Privacy:
 *   We persist email + sub + name (in audit log only). No tokens stored.
 *   Google's own logs are out of our scope; see docs/governance/PRIVACY.md.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env.js';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { getLogger } from '../../config/logger.js';
import { errors } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { COOKIE, setCookie } from '../../shared/utils/cookies.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';

const STATE_COOKIE = '__Host-oauth_state';
const STATE_TTL_SECONDS = 600;

interface GoogleIdTokenClaims {
  iss: string;
  aud: string;
  exp: number;
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

export function isOAuthEnabled(): boolean {
  const env = getEnv();
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();
  const log = getLogger();

  if (!isOAuthEnabled()) {
    // Surface a discoverable status route so the frontend knows whether to
    // render the Google button. No 404s, no guessing.
    app.get('/auth/oauth/providers', async () => ({ google: false }));
    log.info('oauth.disabled — set GOOGLE_OAUTH_* env vars to enable');
    return;
  }

  const prisma = getPrisma();
  const redis = getRedis();
  const authService = new AuthService(new AuthRepository(prisma), redis);

  app.get('/auth/oauth/providers', async () => ({ google: true }));

  app.get('/auth/oauth/google/start', async (req, reply) => {
    const nonce = randomBytes(24).toString('base64url');
    const sig = signState(nonce);
    setCookie(reply, STATE_COOKIE, `${nonce}.${sig}`, {
      maxAgeSeconds: STATE_TTL_SECONDS,
      httpOnly: true,
      sameSite: 'lax', // must allow cross-site GET back from accounts.google.com
    });

    const params = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
      response_type: 'code',
      scope: 'openid email profile',
      state: nonce,
      access_type: 'online',
      prompt: 'select_account',
    });
    if (env.GOOGLE_OAUTH_ALLOWED_DOMAINS.length === 1) {
      // hd hint nudges Google to default to the work account; doesn't enforce.
      params.set('hd', env.GOOGLE_OAUTH_ALLOWED_DOMAINS[0]!);
    }
    reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
  });

  app.get('/auth/oauth/google/callback', async (req, reply) => {
    const query = z
      .object({
        code: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    if (query.error) {
      log.warn({ error: query.error }, 'oauth.google.user-cancelled');
      return reply.redirect(`${env.APP_URL}/login?oauth=cancelled`, 302);
    }
    if (!query.code || !query.state) throw errors.badRequest('Missing OAuth params');

    // Validate state cookie binding — prevents CSRF token-injection.
    const stateCookie = readStateCookie(req);
    if (!stateCookie) throw errors.badRequest('OAuth state cookie missing or expired');
    if (!verifyState(query.state, stateCookie)) {
      throw errors.badRequest('OAuth state mismatch');
    }
    setCookie(reply, STATE_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true });

    // Exchange code → tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '<unreadable>');
      log.error({ status: tokenRes.status, detail }, 'oauth.google.token-exchange-failed');
      throw errors.unauthorized('OAuth token exchange failed');
    }
    const tokenJson = (await tokenRes.json()) as { id_token?: string };
    if (!tokenJson.id_token) throw errors.unauthorized('OAuth response missing id_token');

    // Verify id_token via Google's tokeninfo endpoint. Cheaper + correct
    // than maintaining our own JWKS verifier; we still cross-check claims
    // (aud, iss, exp, email_verified) before trusting the response.
    const claims = await verifyIdToken(tokenJson.id_token, env.GOOGLE_OAUTH_CLIENT_ID!);
    if (!claims.email_verified) throw errors.unauthorized('Google email not verified');

    if (env.GOOGLE_OAUTH_ALLOWED_DOMAINS.length > 0) {
      const domain = claims.email.split('@')[1]?.toLowerCase();
      if (!domain || !env.GOOGLE_OAUTH_ALLOWED_DOMAINS.includes(domain)) {
        log.warn({ email: claims.email }, 'oauth.google.domain-rejected');
        return reply.redirect(`${env.APP_URL}/login?oauth=domain-not-allowed`, 302);
      }
    }

    // Match-or-refuse. Find by stored sub first (stable); fall back to
    // email for first-time login. Never auto-create.
    let user = await prisma.user.findUnique({ where: { googleSub: claims.sub } });
    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email: claims.email } });
      if (!byEmail || byEmail.deletedAt) {
        log.warn({ email: claims.email }, 'oauth.google.no-matching-user');
        return reply.redirect(`${env.APP_URL}/login?oauth=no-account`, 302);
      }
      // First time: stamp the sub so future logins match by stable id.
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { googleSub: claims.sub },
      });
    }

    const issued = await authService.issueSessionForUser(user, 'standard');
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
      userId: user.id,
      action: 'USER_LOGIN_OAUTH',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { provider: 'google', email: claims.email, name: claims.name ?? null },
    });

    return reply.redirect(`${env.APP_URL}/`, 302);
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────

function signState(nonce: string): string {
  const env = getEnv();
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(nonce).digest('base64url');
}

function verifyState(nonce: string, cookieValue: string): boolean {
  const [cookieNonce, cookieSig] = cookieValue.split('.') as [string, string];
  if (!cookieNonce || !cookieSig) return false;
  if (cookieNonce !== nonce) return false;
  const expected = signState(nonce);
  const a = Buffer.from(cookieSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readStateCookie(req: { headers: { cookie?: string } }): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${STATE_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(STATE_COOKIE.length + 1)) : null;
}

async function verifyIdToken(idToken: string, expectedAud: string): Promise<GoogleIdTokenClaims> {
  // tokeninfo validates signature + expiry; we still re-check aud + iss to
  // defend against a misconfigured key returning a stale-but-valid token.
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );
  if (!res.ok) throw errors.unauthorized('id_token verification failed');
  const claims = (await res.json()) as GoogleIdTokenClaims;
  if (claims.aud !== expectedAud) throw errors.unauthorized('id_token aud mismatch');
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    throw errors.unauthorized('id_token iss mismatch');
  }
  if (claims.exp * 1000 <= Date.now()) throw errors.unauthorized('id_token expired');
  return claims;
}
