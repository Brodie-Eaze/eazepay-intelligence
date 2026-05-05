/**
 * Bearer token authentication.
 *
 * Sits alongside the cookie-based `requireAuth`. Used by service-to-service
 * callers (BI tools, internal scripts). The token is validated by:
 *   1. Parse `Bearer epi_pk_<prefix>_<secret>` from `Authorization` header
 *   2. Look up `api_tokens` row by `prefix`
 *   3. Verify token isn't revoked or expired
 *   4. Constant-time compare hashed-secret
 *   5. Hydrate `req.auth` with the token's owning user + scope
 *   6. Bump `last_used_at` (fire-and-forget; one-per-minute would be nicer
 *      but we do it inline for simplicity until perf demands otherwise)
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { errors } from '../errors/app-error.js';
import { getPrisma } from '../../config/database.js';
import { hashesMatch, parseApiToken } from '../utils/api-token.js';

export async function requireBearerAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw errors.unauthorized('Bearer token required');
  }
  const token = header.slice('Bearer '.length).trim();
  const parsed = parseApiToken(token);
  if (!parsed) throw errors.unauthorized('Malformed bearer token');

  const row = await getPrisma().apiToken.findUnique({
    where: { prefix: parsed.prefix },
    include: { user: { select: { id: true, email: true, role: true, deletedAt: true } } },
  });
  if (!row || !row.user || row.user.deletedAt) throw errors.unauthorized('Token not recognised');
  if (row.revokedAt) throw errors.unauthorized('Token revoked');
  if (row.expiresAt && row.expiresAt.getTime() < Date.now())
    throw errors.unauthorized('Token expired');
  if (!hashesMatch(row.hashedSecret, parsed.secretHash)) throw errors.unauthorized('Invalid token');

  // Bump last_used_at (best-effort).
  void getPrisma()
    .apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  req.auth = {
    userId: row.user.id,
    email: row.user.email,
    role: row.user.role,
    scope: 'standard',
    jti: row.id,
  };
}

/**
 * Try cookie auth first; fall back to bearer. Routes can use this so they're
 * callable from both the dashboard (cookie) and BI/programmatic clients (PAT).
 */
export async function requireCookieOrBearer(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { requireAuth } = await import('./auth.middleware.js');
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return requireBearerAuth(req, reply);
  }
  return requireAuth(req, reply);
}
