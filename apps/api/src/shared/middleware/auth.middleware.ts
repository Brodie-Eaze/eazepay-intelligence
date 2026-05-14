import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { OrgRole, PlatformRole } from '@prisma/client';
import { errors } from '../errors/app-error.js';
import { COOKIE, readCookie } from '../utils/cookies.js';
import { verifyJwt } from '../utils/jwt.js';
import { getPrisma } from '../../config/database.js';

/**
 * Hydrate `req.auth` from the access cookie. Throws 401 if missing/invalid.
 * Use as a `preHandler` on every protected route.
 *
 * Phase 1.3 update: also loads `platformRole` so cross-org platform staff
 * can be recognised at every request. Org context (`orgId`/`orgRole`) is
 * NOT populated here — that's the job of `resolveTenantFromPath` which
 * runs after `requireAuth` on routes that live under `/o/:orgSlug/...`.
 * This separation keeps platform-only routes (`/platform/...`) cheap:
 * they need user identity but no tenant resolution.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = readCookie(req, COOKIE.ACCESS);
  if (!token) throw errors.unauthorized('Missing access cookie');
  const payload = verifyJwt(token, 'access');

  // Soft-deleted users lose access immediately. We re-read role +
  // platformRole on every request rather than trusting the JWT — those
  // are the most security-sensitive fields, and the cost of one indexed
  // lookup is acceptable for that property.
  const user = await getPrisma().user.findFirst({
    where: { id: payload.sub, deletedAt: null },
    select: { id: true, email: true, role: true, platformRole: true },
  });
  if (!user) throw errors.unauthorized('User not found or deactivated');

  // Org context comes from the JWT (embedded at login by signAccess). The
  // user's `platformRole` is re-checked from the DB on every request; the
  // JWT-embedded `platformRole` is a fast-path hint that we cross-check.
  // Mismatch (revoked platform role) → trust the DB.
  const platformRole = user.platformRole;

  req.auth = {
    userId: user.id,
    email: user.email,
    role: user.role,
    orgId: payload.org,
    orgRole: payload.orgRole,
    platformRole,
    scope: payload.scope ?? 'standard',
    jti: payload.jti,
  };
}

/**
 * Resolve the active organisation from the URL path parameter `:orgSlug`
 * and populate `req.auth.orgId` + `req.auth.orgRole`. Use as a preHandler
 * on every route under `/api/v1/o/:orgSlug/...`.
 *
 * Membership is the authoritative source. The middleware:
 *   1. reads `:orgSlug` from the route params,
 *   2. loads the Organization (404 if not found, deleted, or unknown),
 *   3. for users without `platformRole`: loads the user's Membership in
 *      this org (403 if absent),
 *   4. for users with `platformRole = STAFF` or `SUPER`: synthesises an
 *      `ADMIN` org-role so platform staff can act in any org without
 *      needing a real Membership row,
 *   5. populates `req.auth.orgId` + `req.auth.orgRole`.
 *
 * 404 vs 403 distinction is deliberate. 404 ("org not found") is returned
 * to ALL non-members, not just non-existent slugs — never 403. Returning
 * 403 would confirm the org's existence to a user who isn't a member,
 * which is information disclosure across tenants.
 *
 * IMPORTANT: assumes `requireAuth` has already populated `req.auth`. The
 * recommended preHandler chain is `[requireAuth, resolveTenantFromPath, ...]`.
 */
export async function resolveTenantFromPath(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!req.auth) {
    throw errors.unauthorized('resolveTenantFromPath requires prior auth');
  }
  const params = req.params as { orgSlug?: string };
  const slug = params.orgSlug;
  if (!slug) {
    throw errors.badRequest('Route is missing :orgSlug');
  }
  const prisma = getPrisma();
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, deletedAt: true },
  });
  // Treat unknown slug, soft-deleted org, and non-membership identically
  // to avoid leaking org existence to non-members.
  if (!org || org.deletedAt) {
    throw errors.notFound('Organization not found');
  }

  // Platform staff bypass membership — they get a synthesised ADMIN role.
  // Their access is still audited (the platform-staff cross-tenant audit
  // category in Phase 1.6 records every cross-org read).
  if (req.auth.platformRole === 'STAFF' || req.auth.platformRole === 'SUPER') {
    req.auth.orgId = org.id;
    req.auth.orgRole = 'ADMIN';
    return;
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.auth.userId, orgId: org.id } },
    select: { role: true },
  });
  if (!membership) {
    throw errors.notFound('Organization not found');
  }
  req.auth.orgId = org.id;
  req.auth.orgRole = membership.role;
}

/**
 * Convenience composite: `requireAuth` + `resolveTenantFromPath`. Most
 * tenant-scoped routes will use this directly.
 */
export const requireAuthAndTenant: preHandlerHookHandler = async (req, reply) => {
  await requireAuth(req, reply);
  await resolveTenantFromPath(req, reply);
};
