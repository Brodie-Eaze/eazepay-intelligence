import type { FastifyRequest, FastifyReply } from 'fastify';
import { errors } from '../errors/app-error.js';
import { COOKIE, readCookie } from '../utils/cookies.js';
import { verifyJwt } from '../utils/jwt.js';
import { getPrisma } from '../../config/database.js';

/**
 * Hydrate `req.auth` from the access cookie. Throws 401 if missing/invalid.
 * Use as a `preHandler` on every protected route.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = readCookie(req, COOKIE.ACCESS);
  if (!token) throw errors.unauthorized('Missing access cookie');
  const payload = verifyJwt(token, 'access');

  // Soft-deleted users lose access immediately.
  const user = await getPrisma().user.findFirst({
    where: { id: payload.sub, deletedAt: null },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw errors.unauthorized('User not found or deactivated');

  req.auth = {
    userId: user.id,
    email: user.email,
    role: user.role,
    scope: payload.scope ?? 'standard',
    jti: payload.jti,
  };
}

/**
 * Optional auth — populates `req.auth` if present, never throws.
 * Used for endpoints that vary their response by scope but don't require login.
 */
export async function optionalAuth(req: FastifyRequest): Promise<void> {
  try {
    await requireAuth(req, {} as FastifyReply);
  } catch {
    // intentionally swallowed
  }
}
