import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { UserRole, OrgRole, PlatformRole } from '@prisma/client';
import { errors } from '../errors/app-error.js';

/**
 * Require any of the listed roles. Investor scope is enforced separately —
 * this guards on underlying ROLE, not session scope.
 *
 * @deprecated since Phase 1.3. Migrate to `requireOrgRole` for tenant-scoped
 * routes or `requirePlatformRole` for cross-tenant platform routes. Kept
 * during the migration window; will be removed at the end of Phase 1.
 */
export function requireRole(...allowed: UserRole[]): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    const auth = req.auth;
    if (!auth) throw errors.unauthorized();
    if (!allowed.includes(auth.role)) {
      throw errors.forbidden(`Requires one of: ${allowed.join(', ')}`);
    }
  };
}

/**
 * Require the caller to hold one of the listed roles in the active
 * organisation. Reads `req.auth.orgRole` populated by
 * `resolveTenantFromPath` — must run after that middleware.
 *
 * Platform staff (STAFF or SUPER) automatically pass any check because
 * `resolveTenantFromPath` synthesises `orgRole = 'ADMIN'` for them.
 */
export function requireOrgRole(...allowed: OrgRole[]): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    const auth = req.auth;
    if (!auth) throw errors.unauthorized();
    if (!auth.orgRole) {
      // resolveTenantFromPath did not run, or the route is mis-configured.
      throw errors.forbidden('Tenant context missing');
    }
    if (!allowed.includes(auth.orgRole)) {
      throw errors.forbidden(`Requires one of: ${allowed.join(', ')}`);
    }
  };
}

/**
 * Require the caller to hold a platform-level role. Use ONLY for routes
 * that act across organisations or perform platform-internal management
 * (org CRUD, FX rate updates, KMS rotation, cross-tenant reconciliation).
 *
 * `SUPER` satisfies any check — including `STAFF`-required routes — because
 * a SUPER user is always a superset of STAFF privileges.
 */
export function requirePlatformRole(required: PlatformRole): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    const auth = req.auth;
    if (!auth) throw errors.unauthorized();
    const have = auth.platformRole;
    if (!have) throw errors.forbidden('Platform access required');
    if (required === 'STAFF') {
      // STAFF or SUPER both satisfy a STAFF requirement.
      if (have !== 'STAFF' && have !== 'SUPER') {
        throw errors.forbidden('Platform access required');
      }
    } else if (required === 'SUPER') {
      if (have !== 'SUPER') {
        throw errors.forbidden('Platform SUPER access required');
      }
    }
  };
}

/**
 * Block this route entirely when the active session scope is `investor`.
 * Use for routes that must never appear in an investor demo (PII reveal, audit log,
 * clawbacks, user admin).
 */
export const denyInvestorScope: preHandlerHookHandler = async (req) => {
  const auth = req.auth;
  if (!auth) throw errors.unauthorized();
  if (auth.scope === 'investor') {
    throw errors.forbidden('Endpoint not available in investor scope');
  }
};

/** Compose multiple preHandlers in order. */
export function compose(...handlers: preHandlerHookHandler[]): preHandlerHookHandler {
  return async (req, reply) => {
    for (const h of handlers) {
      await h.call(reply.server, req, reply, () => undefined);
      if (reply.sent) return;
    }
  };
}
