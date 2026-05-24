/**
 * Bootstrap org lookup helper — Phase 1 transition.
 *
 * The Phase 1 schema retrofit (migration 20260515120000) added `org_id`
 * NOT NULL to every tenant-scoped table. Backfill rules:
 *   - Rows that reference a `partner_id` inherit `partner.org_id`.
 *   - Rows with no partner reference get the bootstrap-org id (slug='default').
 *
 * The application layer must thread `orgId` through every insert to those
 * tables. Some call paths (webhook signature middleware, aggregation
 * worker, lifecycle worker) don't yet have a tenant context at the moment
 * they need to write. Until those paths gain a proper `orgId` resolution
 * (Phase 1.3 — route-handler retrofit), they use this helper to get the
 * bootstrap org id and audit-log the fallback. The end state is zero call
 * sites of this helper; until then it's a single bookkeeping point.
 *
 * This is NOT a multi-tenant fallback for tenant-scoped routes — those
 * MUST source `orgId` from `req.auth.orgId`. This is only for genuinely
 * pre-tenant-context code paths.
 */
import type { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

let cached: string | undefined;

export async function getBootstrapOrgId(prisma: PrismaClient): Promise<string> {
  if (cached) return cached;
  const row = await prisma.organization.findUnique({
    where: { slug: 'default' },
    select: { id: true },
  });
  if (row) {
    cached = row.id;
    return cached;
  }
  // 2026-05-24 emergency: Railway prod DB was never seeded with the
  // bootstrap org, so every login attempt hit this helper (via
  // issueSession when a user has no Membership row), threw, and returned
  // 500. Self-heal: create the row on first call. Idempotent under
  // concurrent boots — the unique slug means at most one duplicate-create
  // attempt that surfaces as Prisma P2002, which we recover from by
  // re-reading.
  // eslint-disable-next-line no-console
  console.warn('[bootstrap-org] default org not found — seeding on-the-fly');
  try {
    const created = await prisma.organization.create({
      data: { id: uuidv7(), slug: 'default', name: 'Default' },
      select: { id: true },
    });
    cached = created.id;
    return cached;
  } catch (err) {
    const retry = await prisma.organization.findUnique({
      where: { slug: 'default' },
      select: { id: true },
    });
    if (!retry) throw err;
    cached = retry.id;
    return cached;
  }
}

/** Test-only reset. Never call from production code. */
export function __resetBootstrapOrgCacheForTests(): void {
  cached = undefined;
}
