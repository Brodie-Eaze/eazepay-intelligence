/**
 * Seed the seven real businesses Brodie operates into the platform as orgs.
 *
 * The platform IS the data centre for these businesses — every business pipes
 * data into it via the ingestion API or webhook routes. Each business needs:
 *
 *   1. An Organization row (slug, name, region, billing seam).
 *   2. A Membership row binding brodie@amalafinance.com.au as ADMIN.
 *      Brodie also keeps the platform-wide SUPER role for cross-org ops.
 *   3. A per-org PII DEK provisioned via the registered KMS client
 *      (LocalKmsClient in dev, AwsKmsClient in prod via the factory).
 *      Without a DEK the org cannot encrypt any application PII.
 *   4. An ADMIN-scoped Personal Access Token printed to stdout exactly once
 *      so it can be copied into the business's ingestion-side config.
 *      The hashed form is persisted; the plaintext is unrecoverable after
 *      this run. RE-RUNNING the script issues new PATs only for orgs that
 *      do not yet have an active token — old tokens stay valid.
 *
 * Idempotent: safe to re-run. Will not duplicate orgs, memberships, DEKs,
 * or PATs. Adds anything missing.
 *
 * Run:
 *   BROODIE_EMAIL=brodie@amalafinance.com.au \
 *     pnpm --filter api db:seed:portfolio-orgs
 *
 * Prerequisites:
 *   - Phase 1.1 + 1.2a + 1.2b + 1.2f migrations applied.
 *   - seed-bootstrap-org has been run at least once (creates Brodie's user
 *     row + the default org). This script extends from there.
 */
import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { PrismaClient, OrgRole, PlatformRole, ApiTokenScope } from '@prisma/client';
import { LOCAL_DEV_KEY_ID } from '../src/shared/kms/local-kms-client.js';
import { ensureActiveDek } from '../src/shared/kms/tenant-dek.js';
import { bootstrapKms } from '../src/shared/kms/kms-factory.js';

// ─── Business catalogue ─────────────────────────────────────────────────────
//
// `slug` is the URL identifier (lowercase kebab, immutable).
// `name` is the display name.
// `dataRegion` is the AU residency hint (ADR-001) — all five are AU.
// `tokenScopes` are the API-token scopes minted for the ingestion-side caller.
//   READ + WRITE covers the platform's full data-ingestion surface; tighten
//   per business later if any of these is read-only.

interface BusinessSeed {
  readonly slug: string;
  readonly name: string;
  readonly dataRegion: 'au';
  readonly tokenScopes: ApiTokenScope[];
  /** What data this business sends to the platform — operational hint. */
  readonly dataDescription: string;
}

const BUSINESSES: BusinessSeed[] = [
  {
    slug: 'medpay',
    name: 'MedPay',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription: 'Medical/dental BNPL applications + funding + clawbacks.',
  },
  {
    slug: 'tradepay',
    name: 'TradePay',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription: 'Trade-services BNPL applications + funding + processing events.',
  },
  {
    slug: 'coachpay',
    name: 'CoachPay',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription: 'Coach BNPL applications, lender decisions, funding events, clawbacks.',
  },
  {
    slug: 'aurean-ai',
    name: 'Aurean AI',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription:
      'AI ops layer: revenue events, model inference usage, partner/applicant scoring metrics.',
  },
  {
    slug: 'aurean-recruitment',
    name: 'Aurean Recruitment',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription:
      'Candidate placements, rep performance, commission tracking, recruiter productivity.',
  },
  {
    slug: 'micamp-processing',
    name: 'MiCamp Processing',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription:
      'Card-processing rail: settlement events, processing fees, chargeback + reversal ledger.',
  },
  {
    slug: 'highsale',
    name: 'HighSale',
    dataRegion: 'au',
    tokenScopes: [ApiTokenScope.READ, ApiTokenScope.WRITE],
    dataDescription:
      'Credit-data scoring (a.k.a. EZ Check): pre-qual inquiries, risk-band assignments, snapshot lifecycle.',
  },
];

const BROODIE_EMAIL = process.env.BROODIE_EMAIL ?? 'brodie@amalafinance.com.au';

// ─── Token format ──────────────────────────────────────────────────────────
// Matches the existing api-token.routes.ts contract: `epi_pk_<prefix>_<secret>`.
// The prefix is the visible-half stored on the row; the secret is hashed.

const TOKEN_PREFIX = 'epi_pk';
const PREFIX_BYTES = 8;
const SECRET_BYTES = 24;

function generatePat(): { token: string; visiblePrefix: string; hashedSecret: string } {
  const prefixPart = randomBytes(PREFIX_BYTES).toString('base64url');
  const secretPart = randomBytes(SECRET_BYTES).toString('base64url');
  const visiblePrefix = `${TOKEN_PREFIX}_${prefixPart}`;
  const token = `${visiblePrefix}_${secretPart}`;
  const hashedSecret = createHash('sha256').update(secretPart).digest('hex');
  return { token, visiblePrefix, hashedSecret };
}

// ─── Main flow ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log('[portfolio-orgs] starting');

    // KMS bootstrap (same pattern as seed-bootstrap-org).
    if (!process.env.KMS_DEV_SECRET) {
      process.env.KMS_DEV_SECRET = 'eazepay-portfolio-seed-dev-kms-secret-32chars';
    }
    const { driver } = await bootstrapKms();
    console.log(`[portfolio-orgs] kms driver=${driver}`);

    // Resolve Brodie's user. Create if missing — the platform is for him;
    // his user is the precondition for everything else.
    let brodie = await prisma.user.findUnique({
      where: { email: BROODIE_EMAIL },
      select: { id: true, email: true, platformRole: true },
    });
    if (!brodie) {
      const newId = uuidv7();
      await prisma.user.create({
        data: {
          id: newId,
          email: BROODIE_EMAIL,
          // No password — Brodie should set one via the invitation/oauth
          // path or password-reset. Platform SUPER is granted below.
          role: 'ADMIN',
          platformRole: PlatformRole.SUPER,
        },
      });
      brodie = { id: newId, email: BROODIE_EMAIL, platformRole: PlatformRole.SUPER };
      console.log(`[portfolio-orgs] created user ${BROODIE_EMAIL} (SUPER)`);
    } else if (brodie.platformRole !== PlatformRole.SUPER) {
      await prisma.user.update({
        where: { id: brodie.id },
        data: { platformRole: PlatformRole.SUPER },
      });
      console.log(`[portfolio-orgs] granted SUPER to ${brodie.email}`);
    } else {
      console.log(`[portfolio-orgs] user ${brodie.email} already SUPER`);
    }

    const issuedTokens: Array<{ orgSlug: string; token: string }> = [];

    for (const biz of BUSINESSES) {
      console.log(`\n[portfolio-orgs] ── ${biz.name} (${biz.slug}) ──`);

      // 1. Organization (upsert by slug).
      const org = await prisma.organization.upsert({
        where: { slug: biz.slug },
        update: { name: biz.name, dataRegion: biz.dataRegion },
        create: {
          id: uuidv7(),
          slug: biz.slug,
          name: biz.name,
          dataRegion: biz.dataRegion,
        },
      });
      console.log(`  org: id=${org.id}`);

      // 2. Membership (Brodie as ADMIN — idempotent).
      await prisma.membership.upsert({
        where: { userId_orgId: { userId: brodie.id, orgId: org.id } },
        update: {}, // never overwrite
        create: {
          id: uuidv7(),
          userId: brodie.id,
          orgId: org.id,
          role: OrgRole.ADMIN,
        },
      });
      console.log('  membership: Brodie ADMIN');

      // 3. Per-org PII DEK.
      const kekKeyId = process.env.AWS_KMS_KEY_ARN ?? LOCAL_DEV_KEY_ID;
      const dek = await ensureActiveDek(prisma, org.id, {
        kekKeyId,
        purpose: 'PII',
      });
      console.log(`  dek: keyId=${dek.id} version=${dek.version}`);

      // 4. Personal Access Token (only if no active one exists for this org).
      const existingActive = await prisma.apiToken.findFirst({
        where: { orgId: org.id, userId: brodie.id, revokedAt: null },
        select: { id: true, prefix: true },
      });
      if (existingActive) {
        console.log(`  pat: existing active (prefix=${existingActive.prefix}) — not regenerating`);
      } else {
        const { token, visiblePrefix, hashedSecret } = generatePat();
        await prisma.apiToken.create({
          data: {
            id: uuidv7(),
            userId: brodie.id,
            orgId: org.id,
            name: `${biz.slug}-ingestion`,
            prefix: visiblePrefix,
            hashedSecret,
            scopes: biz.tokenScopes,
          },
        });
        issuedTokens.push({ orgSlug: biz.slug, token });
        console.log(`  pat: issued (prefix=${visiblePrefix})`);
      }
    }

    // ─── Print tokens block ───────────────────────────────────────────────
    if (issuedTokens.length === 0) {
      console.log('\n[portfolio-orgs] no new PATs issued — every org already has an active token');
    } else {
      console.log('\n' + '═'.repeat(78));
      console.log(' INGESTION TOKENS — copy these now. Plaintext is unrecoverable.');
      console.log('═'.repeat(78));
      for (const t of issuedTokens) {
        console.log(`\n  ${t.orgSlug}:`);
        console.log(`    ${t.token}`);
      }
      console.log('\n' + '═'.repeat(78) + '\n');
    }

    console.log('[portfolio-orgs] done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[portfolio-orgs] error:', err);
  process.exit(1);
});
