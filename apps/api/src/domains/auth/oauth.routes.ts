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

    // Exchange code → tokens. Phase 7 (SF-011): bounded fetch — without a
    // timeout a Google outage dangles the connection pool indefinitely.
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
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '<unreadable>');
      log.error({ status: tokenRes.status, detail }, 'oauth.google.token-exchange-failed');
      throw errors.unauthorized('OAuth token exchange failed');
    }
    const tokenJson = (await tokenRes.json()) as { id_token?: string };
    if (!tokenJson.id_token) throw errors.unauthorized('OAuth response missing id_token');

    // Verify id_token via local JWKS-based RS256 signature verification.
    // Replaces Google's deprecated /tokeninfo HTTP endpoint (SEC-121). Keys
    // are cached for an hour; on kid miss we force-refresh once before
    // failing. Claims (aud, iss, exp, email_verified) are re-checked below.
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
  // P0 fix (SEC-115): OAuth state HMAC uses OAUTH_STATE_SECRET, not the JWT
  // access secret. Sharing the JWT key meant a single secret compromise
  // forged JWTs, CSRF tokens, AND OAuth state simultaneously. Fallback to
  // JWT_ACCESS_SECRET during the migration window so in-flight OAuth flows
  // complete; production startup requires OAUTH_STATE_SECRET to be set.
  const env = getEnv();
  const stateSecret = env.OAUTH_STATE_SECRET ?? env.JWT_ACCESS_SECRET;
  return createHmac('sha256', stateSecret).update(nonce).digest('base64url');
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

// Phase 4b (SEC-121): JWKS-based id_token verification.
//
// Previous implementation hit Google's deprecated /tokeninfo HTTP endpoint
// to verify each id_token. That endpoint is rate-limited, deprecated, and
// a network MITM (DNS / cert compromise) returning crafted claims would
// be trusted verbatim — we never actually validated the signature
// ourselves. SEC-121 in HARDENING.md flagged this as a P1 hardening item.
//
// JWKS verification: pull Google's signing certs once per JWK_CACHE_TTL,
// verify the id_token's RS256 signature against the matching kid locally,
// then re-check aud + iss + exp + email_verified claims. Pure local crypto
// after the first JWKS pull — no per-login network dependency.
//
// We avoid bringing in a heavy JWT library (jose, jsonwebtoken,
// google-auth-library) and do verification with Node's built-in
// node:crypto. The id_token JWT is HEADER.PAYLOAD.SIGNATURE base64url
// with header.alg = 'RS256' and header.kid pointing into the JWKS.

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const JWK_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — matches Google's published cache-control

interface JwkRsa {
  kty: 'RSA';
  use?: string;
  alg?: string;
  kid: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: JwkRsa[];
}

let jwksCache: { fetchedAt: number; keys: Map<string, JwkRsa> } | undefined;

async function getGoogleJwks(): Promise<Map<string, JwkRsa>> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWK_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  // Phase 7: bounded fetch — Google JWKS outage should not dangle the worker.
  const res = await fetch(GOOGLE_JWKS_URL, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw errors.unauthorized('Google JWKS unavailable');
  }
  const body = (await res.json()) as JwksResponse;
  const keys = new Map<string, JwkRsa>();
  for (const k of body.keys ?? []) {
    if (k.kty === 'RSA' && k.kid) keys.set(k.kid, k);
  }
  jwksCache = { fetchedAt: Date.now(), keys };
  return keys;
}

/** Convert a JWK RSA public key to PEM via node:crypto's KeyObject helpers. */
function jwkToPem(jwk: JwkRsa): import('node:crypto').KeyObject {
  // Node 16+ supports createPublicKey({ key, format: 'jwk' }) directly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey } = require('node:crypto') as typeof import('node:crypto');
  return createPublicKey({
    key: jwk as unknown as import('node:crypto').JsonWebKey,
    format: 'jwk',
  });
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

async function verifyIdToken(idToken: string, expectedAud: string): Promise<GoogleIdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw errors.unauthorized('Malformed id_token');
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Parse header to find kid + verify alg pin.
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  } catch {
    throw errors.unauthorized('id_token header unparseable');
  }
  if (header.alg !== 'RS256') {
    // Alg pinning: refuse anything else (especially HS256 — that confusion
    // attack would let an attacker sign with the public key as a secret).
    throw errors.unauthorized('id_token alg must be RS256');
  }
  if (!header.kid) throw errors.unauthorized('id_token missing kid');

  // Look up the JWK; refresh once if not present (key rotation case).
  let jwks = await getGoogleJwks();
  let jwk = jwks.get(header.kid);
  if (!jwk) {
    // Force-refresh in case Google rotated keys; cache may be stale.
    jwksCache = undefined;
    jwks = await getGoogleJwks();
    jwk = jwks.get(header.kid);
  }
  if (!jwk) throw errors.unauthorized(`id_token kid ${header.kid} not in JWKS`);

  // Verify signature locally.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createVerify } = require('node:crypto') as typeof import('node:crypto');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const ok = verifier.verify(jwkToPem(jwk), b64urlDecode(sigB64));
  if (!ok) throw errors.unauthorized('id_token signature invalid');

  // Decode + re-check claims.
  let claims: GoogleIdTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as GoogleIdTokenClaims;
  } catch {
    throw errors.unauthorized('id_token payload unparseable');
  }
  if (claims.aud !== expectedAud) throw errors.unauthorized('id_token aud mismatch');
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw errors.unauthorized('id_token iss mismatch');
  if (claims.exp * 1000 <= Date.now()) throw errors.unauthorized('id_token expired');
  return claims;
}

/** Test-only reset hook for the JWKS cache. Never call from production code. */
export function __resetJwksCacheForTests(): void {
  jwksCache = undefined;
}
