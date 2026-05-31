import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { errors } from '../errors/app-error.js';
import { COOKIE, readCookie } from '../utils/cookies.js';
import { verifyJwt } from '../utils/jwt.js';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';

/**
 * Phase 4 (SEC-113): access-token deny-list. /auth/logout marks the access
 * JWT's jti revoked with TTL = remaining token lifetime; this middleware
 * checks the deny-list on every request and rejects revoked tokens with
 * 401. Closes the "stolen-access-token-survives-logout" window where the
 * 15-min access cookie remained valid after the user clicked logout.
 *
 * Redis key shape: `denyJti:<jti>` → "1", expiring at the JWT's natural
 * expiry. Cheap on the hot path: one Redis GET per authenticated request,
 * sub-ms typical.
 */
const DENY_JTI_PREFIX = 'denyJti:';
/**
 * Phase 4c: session-id deny-list. /auth/sessions/:id DELETE writes the
 * sessionId here with TTL = remaining access-token life so existing
 * access tokens carrying that `sid` are denied immediately. Distinct from
 * the jti deny-list because one session covers many rotated access tokens.
 */
const DENY_SID_PREFIX = 'denySid:';

/**
 * Mark an access-token jti as revoked until its natural expiry. Called
 * from /auth/logout and password-change paths.
 */
export async function denyJti(jti: string, expiresAt: Date): Promise<void> {
  const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  if (ttlSeconds === 0) return; // already expired naturally
  await getRedis().setex(`${DENY_JTI_PREFIX}${jti}`, ttlSeconds, '1');
}

/**
 * Phase 4c: mark a sessionId revoked for `ttlSeconds` (defaults to one
 * access-token TTL so any outstanding access tokens in that session
 * become unusable before they'd naturally expire).
 */
export async function denySession(sessionId: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  await getRedis().setex(`${DENY_SID_PREFIX}${sessionId}`, ttlSeconds, '1');
}

/**
 * 2026-05-24 emergency: Redis on Railway is flapping with sustained
 * ECONNRESET. Every auth request was hanging 10s+ on the deny-list GET
 * → users couldn't log in. Bound the lookup with a 1.5s timeout and
 * fail-OPEN (treat as "not denied") rather than hang requests forever.
 * The trade-off: a stolen-then-revoked access JWT can be re-used for
 * up to its remaining TTL during a Redis outage. Acceptable because
 * (a) revocation is rare (b) the alternative is total auth lockout
 * for every legitimate user. When Redis is healthy the timeout is
 * irrelevant — local Redis GETs are sub-ms.
 */
async function redisGetWithTimeout(key: string, timeoutMs = 1500): Promise<string | null> {
  return await Promise.race([
    getRedis().get(key),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/** Check whether an access-token jti has been revoked. Fails open on Redis timeout. */
async function isJtiDenied(jti: string): Promise<boolean> {
  try {
    const v = await redisGetWithTimeout(`${DENY_JTI_PREFIX}${jti}`);
    return v !== null;
  } catch {
    return false;
  }
}

/** Phase 4c: check whether a sessionId has been revoked. Fails open on Redis timeout. */
async function isSessionDenied(sid: string): Promise<boolean> {
  try {
    const v = await redisGetWithTimeout(`${DENY_SID_PREFIX}${sid}`);
    return v !== null;
  } catch {
    return false;
  }
}

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

  // Phase 4 (SEC-113): deny-list check. Tokens marked revoked by /auth/logout
  // (and future password-change / hostile-revocation flows) are rejected
  // even though the JWT signature still validates. Sub-millisecond Redis
  // GET on the hot path.
  if (await isJtiDenied(payload.jti)) {
    throw errors.unauthorized('Token revoked');
  }

  // Phase 4c (session revocation): /auth/sessions/:id DELETE writes the
  // sessionId into a Redis deny-list with TTL = access-token life. This
  // makes session revocation effective within a single Redis round-trip
  // rather than waiting for the access token to expire (15 min).
  if (payload.sid && (await isSessionDenied(payload.sid))) {
    throw errors.unauthorized('Session revoked');
  }

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

  // SEC-004: Membership re-check.
  //
  // Prior to 2026-05-17 we trusted `payload.org` + `payload.orgRole`
  // directly from the JWT. If a user was removed from an org after the
  // JWT was minted, the access token kept working against routes that
  // didn't call `resolveTenantFromPath` — for up to JWT_ACCESS_TTL
  // (15 min). Effectively, "remove user from org" had a 15-minute
  // soak before isolation kicked in.
  //
  // Now we re-verify the Membership row on every request for non-platform
  // users. The cost is one indexed lookup; the same `findUnique` shape
  // `resolveTenantFromPath` uses already, so the index is hot. If the
  // membership is gone, we strip orgId/orgRole from the request (rather
  // than 401) so:
  //   - cross-org routes (e.g. /me) keep working,
  //   - tenant-scoped routes fall through to their own orgId check (which
  //     is now ALWAYS present per SEC-002 + SEC-014) and return 400/403,
  //   - the JWT itself remains otherwise valid for fresh org-switch flows.
  //
  // Platform staff (SUPER/STAFF) bypass the check — they have implicit
  // membership in every org by design.
  let effectiveOrgId: string | null = payload.org ?? null;
  let effectiveOrgRole = payload.orgRole;
  const isPlatformStaff = platformRole === 'SUPER' || platformRole === 'STAFF';
  if (!isPlatformStaff && effectiveOrgId) {
    const membership = await getPrisma().membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: effectiveOrgId } },
      select: { role: true },
    });
    if (!membership) {
      // Membership revoked since token minted. Strip the org claim from
      // the request so tenant-scoped routes correctly reject with 400
      // "active organisation required" rather than serve cross-tenant
      // data using a stale claim.
      effectiveOrgId = null;
      effectiveOrgRole = undefined;
    } else if (membership.role !== effectiveOrgRole) {
      // Role changed in DB since token minted — trust the DB.
      effectiveOrgRole = membership.role;
    }
  }

  req.auth = {
    userId: user.id,
    email: user.email,
    role: user.role,
    orgId: effectiveOrgId ?? undefined,
    orgRole: effectiveOrgRole,
    platformRole,
    scope: payload.scope ?? 'standard',
    jti: payload.jti,
    sid: payload.sid,
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
