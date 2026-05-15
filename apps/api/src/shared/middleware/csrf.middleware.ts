import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { errors } from '../errors/app-error.js';
import { COOKIE, readCookie } from '../utils/cookies.js';
import { verifyCsrfToken } from '../../domains/auth/auth.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF: cookie must equal `X-CSRF-Token` header AND signature must verify.
 * Skipped for safe methods. Skipped on routes that opt out via `routeOptions.config.skipCsrf`
 * — used by HMAC-verified webhook + integration ingress routes that authenticate via
 * signature, not session cookies.
 *
 * P0 fix (CR-101 / SEC-107): previous implementation skipped on
 * `req.url.startsWith('/api/v1/webhooks/')`. That check ran against the raw,
 * unnormalised URL — so a request to `/api/v1/webhooks/../auth/scope` matched
 * the prefix and skipped CSRF, while Fastify's router normalised the path and
 * dispatched to `/api/v1/auth/scope`. With SameSite=None cookies in
 * production, that was a one-shot CSRF bypass on any state-mutating route.
 * Replaced with a positive opt-in on routeOptions.config — only routes that
 * declare `skipCsrf: true` get the exemption, and the value is set at route
 * registration time so it cannot be poisoned by request input.
 */
export async function csrfGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;

  // Per-route opt-out. Cast through `unknown` because Fastify's type for
  // routeOptions.config is `Record<string, unknown> & ContextConfigDefault` —
  // we only read a single known field and gate it strictly.
  const routeConfig = req.routeOptions?.config as { skipCsrf?: boolean } | undefined;
  if (routeConfig?.skipCsrf === true) return;

  // Bearer-auth callers (programmatic clients, BI tools, ETL) authenticate
  // via PAT in the Authorization header — they don't ride on session
  // cookies, so CSRF is structurally not applicable to them. The bearer
  // path has its own auth + rate-limit story. Detect via the header
  // explicitly (don't trust req.auth which may not be populated yet — the
  // CSRF guard often runs alongside requireCookieOrBearer rather than after
  // it on the preHandler chain). This match is case-insensitive per RFC 7235.
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && /^bearer\s+/i.test(authHeader)) return;

  // Login route is exempt: there is no session yet, but it's rate-limited per (ip,email).
  // Match the resolved route URL (not req.url) so query strings / path-traversal
  // attempts cannot alter the comparison.
  const resolvedRoute = req.routeOptions?.url ?? '';
  if (resolvedRoute === '/api/v1/auth/login') return;

  const cookieToken = readCookie(req, COOKIE.CSRF);
  const headerToken = req.headers['x-csrf-token'];
  const header = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !header) throw errors.forbidden('CSRF token missing');
  // Timing-safe equality between cookie + header value. Previous `===`
  // short-circuited on the first byte mismatch — a chatty attacker who can
  // read the cookie value (via XSS chained with a separate vuln) could
  // discover the header value byte-by-byte from response timing. Length
  // check first because timingSafeEqual requires equal-length buffers.
  const cookieBuf = Buffer.from(cookieToken, 'utf8');
  const headerBuf = Buffer.from(header, 'utf8');
  if (cookieBuf.length !== headerBuf.length || !timingSafeEqual(cookieBuf, headerBuf)) {
    throw errors.forbidden('CSRF token mismatch');
  }
  if (!verifyCsrfToken(cookieToken)) throw errors.forbidden('CSRF token invalid');
}
