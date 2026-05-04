import type { FastifyRequest, FastifyReply } from 'fastify';
import { errors } from '../errors/app-error.js';
import { COOKIE, readCookie } from '../utils/cookies.js';
import { verifyCsrfToken } from '../../domains/auth/auth.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF: cookie must equal `X-CSRF-Token` header AND signature must verify.
 * Skipped for safe methods. Skipped entirely if route is webhook-signed (those use HMAC).
 */
export async function csrfGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  if (req.url.startsWith('/api/v1/webhooks/')) return;
  // Login route is exempt: there is no session yet, but it's rate-limited per (ip,email).
  if (req.url === '/api/v1/auth/login') return;

  const cookieToken = readCookie(req, COOKIE.CSRF);
  const headerToken = req.headers['x-csrf-token'];
  const header = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !header) throw errors.forbidden('CSRF token missing');
  if (cookieToken !== header) throw errors.forbidden('CSRF token mismatch');
  if (!verifyCsrfToken(cookieToken)) throw errors.forbidden('CSRF token invalid');
}
