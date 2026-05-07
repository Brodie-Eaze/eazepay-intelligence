/**
 * `requireScope` — single authorization gate for endpoints reachable from
 * BOTH the dashboard (cookie session) and programmatic clients (PAT bearer).
 *
 * Why not just `requireRole`? Two-axis problem:
 *   - Cookie callers: identified by `User.role` (ADMIN | OPERATOR | INVESTOR | VIEWER)
 *   - PAT callers:    identified by `ApiToken.scopes` (READ | WRITE | ADMIN)
 *
 * For ingestion endpoints we want to say "WRITE access required" without
 * caring how the caller authenticated. This middleware resolves the request's
 * effective scope from whichever channel produced `req.auth`, then matches it
 * against the required scope.
 *
 * Pre-condition: a prior preHandler has populated `req.auth` (via `requireAuth`,
 * `requireBearerAuth`, or `requireCookieOrBearer`). This middleware does NOT
 * authenticate; it only authorises.
 *
 * SOC 2 mapping:
 *   - CC6.1 (logical access)   — least-privilege at the endpoint surface
 *   - CC6.3 (role-based)       — uniform RBAC regardless of credential type
 *   - CC7.3 (security events)  — denials surface in audit logs via the
 *                                 generic error handler (statusCode 403)
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { errors } from '../errors/app-error.js';
import { getPrisma } from '../../config/database.js';

export type RequiredScope = 'READ' | 'WRITE' | 'ADMIN';

const COOKIE_ROLE_TO_SCOPES: Record<string, RequiredScope[]> = {
  ADMIN: ['READ', 'WRITE', 'ADMIN'],
  OPERATOR: ['READ', 'WRITE'],
  INVESTOR: ['READ'],
  VIEWER: ['READ'],
};

export function requireScope(scope: RequiredScope): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.auth) throw errors.unauthorized('Auth context missing');

    // PAT path: jti is the token id; resolve scopes from the token row.
    if (req.headers.authorization?.startsWith('Bearer ')) {
      const token = await getPrisma().apiToken.findUnique({
        where: { id: req.auth.jti },
        select: { scopes: true },
      });
      const have = token?.scopes ?? [];
      if (have.includes(scope)) return;
      // ADMIN scope implies WRITE+READ; WRITE implies READ.
      if (scope === 'WRITE' && have.includes('ADMIN')) return;
      if (scope === 'READ' && (have.includes('WRITE') || have.includes('ADMIN'))) return;
      throw errors.forbidden(`Token lacks ${scope} scope`);
    }

    // Cookie path: derive from user role.
    const allowed = COOKIE_ROLE_TO_SCOPES[req.auth.role] ?? [];
    if (!allowed.includes(scope)) {
      throw errors.forbidden(`Role ${req.auth.role} lacks ${scope} scope`);
    }
  };
}
