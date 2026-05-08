/**
 * Tenant-namespaced Redis key builder.
 *
 * The blast-radius audit (§4) shows that most existing Redis keys are
 * already org-safe by virtue of being keyed on UUIDs (alert:lock:&lt;ruleId&gt;,
 * ws:ticket:&lt;jti&gt;). The risk surface is:
 *
 *   - Rate-limit buckets keyed only on userId — safe, but per-org buckets
 *     would let us bound tenant blast radius (a noisy tenant can't burn
 *     another's quota).
 *   - Cache keys for tenant-scoped data (org context cache, membership
 *     cache, FX rate cache) that need explicit prefix.
 *   - Pub/sub channel names (ws:analytics) where a single global channel
 *     fans out events across tenants — see blast-radius §6.
 *
 * This module provides the `tenantKey()` helper so all org-scoped Redis
 * keys are constructed identically. Drift across modules is the
 * highest-risk failure mode for cache key schemes (rebuilds, upgrades,
 * migrations all break with inconsistent prefixes).
 *
 * NAMESPACE:
 *   Every tenant-scoped key is prefixed with `t:&lt;orgId&gt;:`. The single-letter
 *   prefix is intentional — Redis stores key strings in memory, and
 *   verbose prefixes (`tenant:&lt;uuid&gt;:`) cost ~25 bytes/key vs ~40 with
 *   the long form. At scale this matters; at our scale it's just neat.
 *
 * GLOBAL KEYS:
 *   Keys that are intentionally global (rate-limit by IP for unauthenticated
 *   /auth/login, BullMQ queue names, system locks) are NOT routed through
 *   this helper. They construct keys directly. This separation makes the
 *   intent visible at every call site.
 */

const TENANT_PREFIX = 't';

/**
 * Build a Redis key scoped to an organisation.
 *
 * @param orgId UUID of the active organisation. NOT validated — caller is
 *              responsible for passing a real Organization.id (typically
 *              from `req.auth.orgId` or `getTenantContext().orgId`).
 * @param parts Key segments joined with `:`. Leading/trailing colons are
 *              not stripped; pass clean segments.
 *
 * @example
 *   tenantKey(orgId, 'org-context')                  → 't:<uuid>:org-context'
 *   tenantKey(orgId, 'membership-cache', userId)     → 't:<uuid>:membership-cache:<userId>'
 *   tenantKey(orgId, 'rate-limit', 'export', userId) → 't:<uuid>:rate-limit:export:<userId>'
 */
export function tenantKey(orgId: string, ...parts: string[]): string {
  if (!orgId) throw new Error('tenantKey: orgId is required');
  return [TENANT_PREFIX, orgId, ...parts].join(':');
}

/**
 * Build a Redis pub/sub channel scoped to an organisation.
 *
 * Channels and keys live in the same namespace in Redis. The `c:` infix
 * distinguishes pub/sub channels from data keys at a glance, useful when
 * grepping `MONITOR` output.
 *
 * @example
 *   tenantChannel(orgId, 'ws:analytics') → 't:<uuid>:c:ws:analytics'
 */
export function tenantChannel(orgId: string, name: string): string {
  if (!orgId) throw new Error('tenantChannel: orgId is required');
  return [TENANT_PREFIX, orgId, 'c', name].join(':');
}

/**
 * Pattern for matching all keys belonging to an org. Used by tenant
 * deletion runbook (Phase 1.6 final): SCAN with this pattern to enumerate
 * all the org's cache + state, then DEL in batches.
 *
 * @example
 *   tenantKeyPattern(orgId) → 't:<uuid>:*'
 */
export function tenantKeyPattern(orgId: string): string {
  if (!orgId) throw new Error('tenantKeyPattern: orgId is required');
  return `${TENANT_PREFIX}:${orgId}:*`;
}

/**
 * Extract the orgId from a tenant-scoped key. Returns null if the key
 * doesn't match the expected `t:<uuid>:*` shape — useful for log
 * normalisation where you want to attribute Redis ops to a tenant.
 */
export function extractOrgIdFromKey(key: string): string | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  if (parts[0] !== TENANT_PREFIX) return null;
  return parts[1] ?? null;
}
