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
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { PrismaClient, OrgRole, PlatformRole, UserRole, WebhookSource } from '@prisma/client';
import { LOCAL_DEV_KEY_ID } from '../src/shared/kms/local-kms-client.js';
import { ensureActiveDek } from '../src/shared/kms/tenant-dek.js';
import { bootstrapKms } from '../src/shared/kms/kms-factory.js';

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
    // ─── Webhook credential bootstrap ──────────────────────────────────────
    // Replace sentinel hashes (created by the migration) with real
    // sha256(secret) values derived from the env vars. Idempotent — only
    // updates rows that still hold the sentinel.
    const SENTINEL_HASH = 'b7e94be513e96e8c45cd23d162275e5a12ebde9100a425c4ebcdd7fa4dcd897c';
    const webhookEnv: Record<WebhookSource, string | undefined> = {
      [WebhookSource.BUZZPAY]: process.env.BUZZPAY_WEBHOOK_SECRET,
      [WebhookSource.PIXIE]: process.env.PIXIE_WEBHOOK_SECRET,
      [WebhookSource.MICAMP]: process.env.MICAMP_WEBHOOK_SECRET,
    };
    let webhookUpdated = 0;
    let webhookMissing = 0;
    for (const [source, secret] of Object.entries(webhookEnv)) {
      if (!secret) {
        webhookMissing += 1;
        console.warn(
          `[bootstrap-org] no env secret for ${source} — sentinel hash retained (webhook ingress for ${source} will fail signature verification until set)`,
        );
        continue;
      }
      const hash = createHash('sha256').update(secret).digest('hex');
      const r = await prisma.webhookCredential.updateMany({
        where: { orgId: org.id, source: source as WebhookSource, signingSecretHash: SENTINEL_HASH },
        data: { signingSecretHash: hash },
      });
      if (r.count > 0) webhookUpdated += r.count;
    }
    console.log(
      `[bootstrap-org] webhook credentials: updated=${webhookUpdated}, missing=${webhookMissing}`,
    );

    // ─── DEK provisioning ──────────────────────────────────────────────────
    // Provision the bootstrap org's PII DEK if absent. The KMS factory
    // picks LocalKmsClient (dev) or AwsKmsClient (prod) per env. Production
    // requires AWS_KMS_KEY_ARN; the factory throws if missing.
    if (!process.env.KMS_DEV_SECRET) {
      // Deterministic dev placeholder. NEVER use this value in prod —
      // the factory only reads it when picking LocalKmsClient.
      process.env.KMS_DEV_SECRET = 'eazepay-bootstrap-dev-kms-secret-not-for-prod';
    }
    const { driver } = await bootstrapKms();
    const kekKeyId = process.env.AWS_KMS_KEY_ARN ?? LOCAL_DEV_KEY_ID;
    const dek = await ensureActiveDek(prisma, org.id, {
      kekKeyId,
      purpose: 'PII',
    });
    console.log(
      `[bootstrap-org] PII DEK ready: driver=${driver} keyId=${dek.id} version=${dek.version}`,
    );

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
