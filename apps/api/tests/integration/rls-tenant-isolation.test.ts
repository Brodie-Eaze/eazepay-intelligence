/**
 * Phase 1.4 — RLS tenant isolation integration test.
 *
 * Connects to the local Postgres as a non-superuser role (eazepay_app) so
 * the row-level-security policies actually enforce. Connecting as the
 * superuser bypasses RLS entirely (Postgres design), so this test would be
 * meaningless without the role switch.
 *
 * Live test — skipped silently when:
 *   - the eazepay_app role doesn't exist on the local DB (init-timescale.sql
 *     hasn't been run), or
 *   - $DATABASE_URL doesn't point at a local Postgres we can introspect, or
 *   - we can't connect as eazepay_app (password mismatch).
 *
 * What it proves:
 *   1. Without app.org_id set → eazepay_app sees zero memberships
 *      (default-deny behaviour).
 *   2. With app.org_id = orgA → eazepay_app sees ONLY orgA's memberships.
 *   3. With app.org_id = orgB → ONLY orgB's memberships.
 *   4. With app.platform_staff = 'true' → all memberships across orgs.
 *   5. INSERT with the wrong org_id is rejected by the WITH CHECK clause.
 *
 * Side effect: this test creates two test orgs, two test users, and two
 * memberships, then cleans them up at the end. Failure to clean up leaves
 * artefacts in the local DB but does not corrupt anything used by the API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

// Resolve the dev DATABASE_URL even when vitest hasn't auto-loaded .env.
// Order: process.env → apps/api/.env → empty (suite skips).
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = pathResolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return '';
  const text = readFileSync(envPath, 'utf8');
  const match = text.match(/^DATABASE_URL=(.+)$/m);
  return match?.[1]?.trim() ?? '';
}

// The eazepay_app password is set by init-timescale.sql. Default placeholder
// is 'change-me-in-prod'; override with an env var if local custom.
const APP_USER = 'eazepay_app';
const APP_PASSWORD = process.env.EAZEPAY_APP_PASSWORD ?? 'change-me-in-prod';

function buildAppRoleUrl(primaryUrl: string): string {
  if (!primaryUrl) return '';
  try {
    const u = new URL(primaryUrl);
    u.username = APP_USER;
    u.password = APP_PASSWORD;
    return u.toString();
  } catch {
    return '';
  }
}

async function canConnectAsAppRole(appUrl: string): Promise<boolean> {
  if (!appUrl) return false;
  const probe = new PrismaClient({ datasources: { db: { url: appUrl } } });
  try {
    await probe.$connect();
    await probe.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

// Synchronous enablement check at module load — vitest evaluates skipIf
// at describe registration time, so `let suiteEnabled = ...` set inside
// beforeAll comes too late.
const PRIMARY_URL = resolveDatabaseUrl();
const APP_URL_FOR_RLS = buildAppRoleUrl(PRIMARY_URL);
// We can't probe the DB synchronously; instead we run the suite whenever a
// DATABASE_URL is resolvable and trust beforeAll to throw with a clear
// message if the eazepay_app role isn't reachable. That's the right
// failure mode: silent skip hides config drift from CI, where this test
// is the load-bearing proof of tenant isolation.
const SUITE_ENABLED = Boolean(PRIMARY_URL) && Boolean(APP_URL_FOR_RLS);

describe.skipIf(!SUITE_ENABLED)('RLS tenant isolation (Phase 1.4)', () => {
  let admin: PrismaClient; // table owner — bypasses RLS — used to create fixtures.
  let app: PrismaClient; // eazepay_app — RLS enforces.

  // Fixture identifiers — bound at runtime in beforeAll.
  let orgA = '';
  let orgB = '';
  let userA = '';
  let userB = '';

  beforeAll(async () => {
    if (!(await canConnectAsAppRole(APP_URL_FOR_RLS))) {
      throw new Error(
        `RLS test cannot connect as ${APP_USER}. Run apps/api/prisma/init-timescale.sql ` +
          `or set EAZEPAY_APP_PASSWORD if using a non-default password. URL host: ${
            new URL(APP_URL_FOR_RLS).host
          }`,
      );
    }
    admin = new PrismaClient({ datasources: { db: { url: PRIMARY_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL_FOR_RLS } } });

    // Create two orgs + two users + two memberships, all via the admin role
    // which bypasses RLS. Use distinctive slug prefixes so cleanup is robust.
    const stamp = Date.now().toString(36);
    orgA = uuidv7();
    orgB = uuidv7();
    userA = uuidv7();
    userB = uuidv7();

    await admin.$transaction([
      admin.organization.create({
        data: { id: orgA, slug: `rls-test-a-${stamp}`, name: 'RLS Test Org A' },
      }),
      admin.organization.create({
        data: { id: orgB, slug: `rls-test-b-${stamp}`, name: 'RLS Test Org B' },
      }),
      admin.user.create({
        data: { id: userA, email: `rls-a-${stamp}@example.com`, role: 'ADMIN' },
      }),
      admin.user.create({
        data: { id: userB, email: `rls-b-${stamp}@example.com`, role: 'ADMIN' },
      }),
      admin.membership.create({
        data: { id: uuidv7(), userId: userA, orgId: orgA, role: 'ADMIN' },
      }),
      admin.membership.create({
        data: { id: uuidv7(), userId: userB, orgId: orgB, role: 'ADMIN' },
      }),
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    // Tear down via admin (no RLS). Order: memberships → users → orgs
    // because of FK constraints.
    await admin.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
    await admin.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await admin.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await admin.$disconnect();
    await app.$disconnect();
  });

  it('default-denies when no GUC is set', async () => {
    // Inside a tx with NO app.org_id and NO platform_staff → policy clauses
    // both evaluate to false, so SELECT returns zero rows.
    const result = await app.$transaction(async (tx) => {
      return tx.membership.findMany({
        where: { orgId: { in: [orgA, orgB] } },
      });
    });
    expect(result).toHaveLength(0);
  });

  it('with app.org_id = orgA → returns only orgA memberships', async () => {
    const result = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgA}, true)`;
      return tx.membership.findMany({
        where: { orgId: { in: [orgA, orgB] } },
        select: { orgId: true },
      });
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.orgId === orgA)).toBe(true);
  });

  it('with app.org_id = orgB → returns only orgB memberships', async () => {
    const result = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgB}, true)`;
      return tx.membership.findMany({
        where: { orgId: { in: [orgA, orgB] } },
        select: { orgId: true },
      });
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.orgId === orgB)).toBe(true);
  });

  it('with app.platform_staff = true → returns memberships across all orgs', async () => {
    const result = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
      return tx.membership.findMany({
        where: { orgId: { in: [orgA, orgB] } },
        select: { orgId: true },
      });
    });
    const distinct = new Set(result.map((r) => r.orgId));
    expect(distinct.has(orgA)).toBe(true);
    expect(distinct.has(orgB)).toBe(true);
  });

  it('INSERT with wrong org_id is rejected by WITH CHECK', async () => {
    // Set tenant context to orgA, then try to insert a membership for orgB.
    // Postgres should reject with code 42501 / "new row violates row-level
    // security policy" or similar.
    const attempt = app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgA}, true)`;
      await tx.membership.create({
        data: {
          id: uuidv7(),
          userId: userB, // user from org B
          orgId: orgB, // BUT writing as orgA tenant
          role: 'ADMIN',
        },
      });
    });
    await expect(attempt).rejects.toThrow();
  });
});
