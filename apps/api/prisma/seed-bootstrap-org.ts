/**
 * Phase 1.1 bootstrap — create the default Organization and migrate every
 * existing User to a Membership in it.
 *
 * Idempotent. Safe to run multiple times. Does not alter user-supplied data.
 *
 * Pre-conditions:
 *   - Migration 20260508140000_phase1_1_organization_membership has run.
 *   - At least one user exists (otherwise this is a no-op except for the
 *     org creation, which is fine).
 *
 * Post-conditions:
 *   - exactly one Organization with slug = 'default' exists
 *   - every active User (deletedAt IS NULL) has exactly one Membership
 *     in the default org with role = User.role
 *   - if BOOTSTRAP_PLATFORM_SUPER_EMAIL is set, that user gets
 *     platformRole = SUPER (to seed Brodie's cross-org access)
 *
 * Run:
 *   BOOTSTRAP_PLATFORM_SUPER_EMAIL=brodie@amalafinance.com.au \
 *     pnpm --filter api db:seed:bootstrap-org
 *
 * Why a separate script (not a SQL migration):
 *   The mapping from User.role → Membership.role is straightforward but
 *   the "Brodie gets SUPER" decision is operator policy, not schema. SQL
 *   migrations should not contain operational decisions about specific
 *   user accounts. This script is the right home for both.
 */
import { v7 as uuidv7 } from 'uuid';
import { PrismaClient, OrgRole, PlatformRole, UserRole } from '@prisma/client';

const DEFAULT_ORG_SLUG = 'default';
const DEFAULT_ORG_NAME = 'EazePay Intelligence (default)';

const ROLE_MAP: Record<UserRole, OrgRole> = {
  ADMIN: OrgRole.ADMIN,
  OPERATOR: OrgRole.OPERATOR,
  INVESTOR: OrgRole.INVESTOR,
  VIEWER: OrgRole.VIEWER,
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log('[bootstrap-org] starting');

    const org = await prisma.organization.upsert({
      where: { slug: DEFAULT_ORG_SLUG },
      update: {},
      create: {
        id: uuidv7(),
        slug: DEFAULT_ORG_SLUG,
        name: DEFAULT_ORG_NAME,
        dataRegion: 'au',
      },
    });
    console.log(`[bootstrap-org] organization id=${org.id} slug=${org.slug}`);

    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, email: true, role: true, platformRole: true },
    });
    console.log(`[bootstrap-org] migrating ${users.length} users → memberships`);

    let createdMemberships = 0;
    let existingMemberships = 0;
    for (const user of users) {
      const result = await prisma.membership.upsert({
        where: { userId_orgId: { userId: user.id, orgId: org.id } },
        update: {}, // never overwrite an existing role — admin-only mutation
        create: {
          id: uuidv7(),
          userId: user.id,
          orgId: org.id,
          role: ROLE_MAP[user.role],
        },
      });
      // Prisma's upsert doesn't tell us which path executed; we infer by
      // comparing createdAt to "just now."
      const justCreated = Date.now() - result.createdAt.getTime() < 5_000;
      if (justCreated) createdMemberships += 1;
      else existingMemberships += 1;
    }
    console.log(
      `[bootstrap-org] memberships: created=${createdMemberships}, already_present=${existingMemberships}`,
    );

    const superEmail = process.env.BOOTSTRAP_PLATFORM_SUPER_EMAIL;
    if (superEmail) {
      const existingSuper = users.find((u) => u.email === superEmail);
      if (!existingSuper) {
        console.warn(
          `[bootstrap-org] BOOTSTRAP_PLATFORM_SUPER_EMAIL=${superEmail} but no matching user — skipping`,
        );
      } else if (existingSuper.platformRole === 'SUPER') {
        console.log(`[bootstrap-org] platform SUPER already set on ${superEmail}`);
      } else {
        await prisma.user.update({
          where: { email: superEmail },
          data: { platformRole: PlatformRole.SUPER },
        });
        console.log(`[bootstrap-org] platform SUPER granted to ${superEmail}`);
      }
    } else {
      console.log(
        '[bootstrap-org] BOOTSTRAP_PLATFORM_SUPER_EMAIL not set — no platform role granted',
      );
    }

    // Sanity assertions — fail loud if invariants are violated.
    const usersWithoutMembership = await prisma.user.count({
      where: { deletedAt: null, memberships: { none: {} } },
    });
    if (usersWithoutMembership > 0) {
      throw new Error(
        `[bootstrap-org] FAIL: ${usersWithoutMembership} active users without a membership`,
      );
    }
    const orgCount = await prisma.organization.count({
      where: { slug: DEFAULT_ORG_SLUG },
    });
    if (orgCount !== 1) {
      throw new Error(`[bootstrap-org] FAIL: expected 1 default org, found ${orgCount}`);
    }
    console.log('[bootstrap-org] invariants OK');

    console.log('[bootstrap-org] done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[bootstrap-org] error:', err);
  process.exit(1);
});
