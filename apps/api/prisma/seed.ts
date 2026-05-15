import { Prisma, PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import argon2 from 'argon2';
import { encryptPII } from '../src/shared/utils/encryption.js';
import { computePixieMargin } from '../src/domains/pixie/pixie.algorithm.js';

/**
 * Deterministic seed: 2 users, 12 partners, ~600 applications, ~1800 decisions,
 * 30 days of pixie metrics, ~3000 revenue events with realistic clawback ratio.
 *
 * Idempotent — re-running upserts and skips existing rows.
 */
const prisma = new PrismaClient();

const INDUSTRIES = ['Auto Repair', 'Dental', 'Furniture', 'HVAC', 'Roofing', 'Veterinary'];
const TIERS = ['BRONZE', 'SILVER', 'GOLD'] as const;
const LENDERS: Array<{
  name: string;
  tier: 'PRIME' | 'NEAR_PRIME' | 'SUBPRIME' | 'CARD_LINKED';
  aprMin: number;
  aprMax: number;
}> = [
  { name: 'Helix Prime', tier: 'PRIME', aprMin: 6.99, aprMax: 12.5 },
  { name: 'Bridge Capital', tier: 'NEAR_PRIME', aprMin: 14.99, aprMax: 24.99 },
  { name: 'Last Chance Lending', tier: 'SUBPRIME', aprMin: 28.99, aprMax: 35.99 },
];

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}
function rangeInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main(): Promise<void> {
  console.log('▶ seeding EazePay Intelligence');

  // Phase 1 retrofit: every tenant-scoped row needs an org_id. The seed
  // attaches everything it creates to the bootstrap org (slug='default')
  // which is created by migration 20260508145000.
  const bootstrapOrg = await prisma.organization.findUniqueOrThrow({
    where: { slug: 'default' },
    select: { id: true },
  });
  const orgId = bootstrapOrg.id;

  // GAP-103/104/105: ensure the 7 launch-business orgs exist. The KPI
  // endpoints + business webhook routes resolve into these slugs at
  // ingest time; without the rows, fail-closed kicks in and every
  // request returns 401.
  const LAUNCH_BUSINESSES = [
    { slug: 'medpay', name: 'medpay' },
    { slug: 'tradepay', name: 'tradepay' },
    { slug: 'coachpay', name: 'coachpay' },
    { slug: 'aurean-ai', name: 'Aurean AI' },
    { slug: 'aurean-recruitment', name: 'Aurean Recruitment' },
    { slug: 'micamp-processing', name: 'MiCamp Processing' },
    { slug: 'highsale', name: 'HighSale' },
  ];
  for (const b of LAUNCH_BUSINESSES) {
    await prisma.organization.upsert({
      where: { slug: b.slug },
      create: { id: uuidv7(), slug: b.slug, name: b.name, dataRegion: 'au' },
      update: {},
    });
  }

  // ─── Users ────────────────────────────────────────────────────────────────
  const adminHash = await argon2.hash('Demo!1234', { type: argon2.argon2id });
  const viewerHash = adminHash;
  await prisma.user.upsert({
    where: { email: 'admin@eazepay.local' },
    create: { id: uuidv7(), email: 'admin@eazepay.local', passwordHash: adminHash, role: 'ADMIN' },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: 'operator@eazepay.local' },
    create: {
      id: uuidv7(),
      email: 'operator@eazepay.local',
      passwordHash: adminHash,
      role: 'OPERATOR',
    },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: 'viewer@eazepay.local' },
    create: {
      id: uuidv7(),
      email: 'viewer@eazepay.local',
      passwordHash: viewerHash,
      role: 'VIEWER',
    },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: 'investor@eazepay.local' },
    create: {
      id: uuidv7(),
      email: 'investor@eazepay.local',
      passwordHash: viewerHash,
      role: 'INVESTOR',
    },
    update: {},
  });

  // ─── Partners ─────────────────────────────────────────────────────────────
  const partners = [];
  for (let i = 0; i < 12; i += 1) {
    const tier = TIERS[i % 3]!;
    const externalId = `PRT-${String(i + 1).padStart(4, '0')}`;
    const cost = 1.0;
    const charge = 3.0;
    const partner = await prisma.partner.upsert({
      where: { orgId_externalId: { orgId, externalId } },
      create: {
        id: uuidv7(),
        orgId,
        externalId,
        name: [
          'Apex Auto',
          'Bright Dental',
          'Cozy Couches',
          'Delta HVAC',
          'Eagle Roofing',
          'Furry Friends Vet',
          'Gold Coast Auto',
          'Harbor Dental',
          'Inland Furniture',
          'Jet Stream HVAC',
          'Keystone Roofing',
          'Loyal Companions Vet',
        ][i]!,
        industry: INDUSTRIES[i % INDUSTRIES.length]!,
        onboardingDate: new Date(Date.now() - (365 - i * 25) * 86_400_000),
        status: 'ACTIVE',
        tier,
        contractValue: new Prisma.Decimal(rangeInt(20_000, 250_000)),
        buzzpayRevSharePct: new Prisma.Decimal('0.10'),
        pixieDataPullCost: new Prisma.Decimal(cost.toFixed(4)),
        pixieChargeRate: new Prisma.Decimal(charge.toFixed(4)),
        pixieMargin: new Prisma.Decimal((charge - cost).toFixed(4)),
      },
      update: {},
    });
    partners.push(partner);
  }

  // ─── Applications + Decisions + Funding + Revenue ─────────────────────────
  for (let i = 0; i < 600; i += 1) {
    const partner = rand(partners);
    const externalApplicationId = `APP-${String(i + 1).padStart(6, '0')}`;
    const existing = await prisma.application.findUnique({
      where: { orgId_externalApplicationId: { orgId, externalApplicationId } },
    });
    if (existing) continue;
    const created = new Date(Date.now() - rangeInt(0, 90) * 86_400_000);
    const status = pickWeighted([
      ['SUBMITTED', 0.25],
      ['IN_REVIEW', 0.1],
      ['APPROVED', 0.1],
      ['DECLINED', 0.2],
      ['FUNDED', 0.35],
    ] as const);

    const name = encryptPII(`Demo Consumer ${i}`);
    const email = encryptPII(`consumer${i}@example.test`);
    const phone = encryptPII(`+61400000${String(i).padStart(3, '0')}`);

    const app = await prisma.application.create({
      data: {
        id: uuidv7(),
        orgId,
        partnerId: partner.id,
        externalApplicationId,
        consumerNameCiphertext: name.ciphertext,
        consumerEmailCiphertext: email.ciphertext,
        consumerEmailHash: email.hash,
        consumerPhoneCiphertext: phone.ciphertext,
        consumerPhoneHash: phone.hash,
        creditScore: rangeInt(540, 820),
        availableCredit: new Prisma.Decimal(rangeInt(2_000, 50_000)),
        notedAnnualIncome: new Prisma.Decimal(rangeInt(45_000, 220_000)),
        bankStatementsProvided: Math.random() > 0.5,
        merchantPreapproval: Math.random() > 0.6,
        consumerPreapproval: Math.random() > 0.4,
        fundingEstimate: new Prisma.Decimal(rangeInt(2_000, 25_000)),
        propensityScore: new Prisma.Decimal(Math.random().toFixed(4)),
        openLinesOfCredit: rangeInt(0, 8),
        status,
        submittedAt: created,
        createdAt: created,
        updatedAt: created,
      },
    });

    // Cascade decisions for non-pending statuses.
    if (status !== 'SUBMITTED') {
      const lender = rand(LENDERS);
      const decisionAt = new Date(created.getTime() + 60 * 60_000);
      const decision = status === 'DECLINED' ? 'DECLINED' : 'APPROVED';
      const apr =
        decision === 'APPROVED' ? rangeInt(lender.aprMin * 100, lender.aprMax * 100) / 100 : null;
      const approvalAmt = decision === 'APPROVED' ? rangeInt(2_000, 25_000) : null;

      const decisionRow = await prisma.lenderDecision.create({
        data: {
          id: uuidv7(),
          orgId,
          applicationId: app.id,
          partnerId: partner.id,
          lenderName: lender.name,
          lenderTier: lender.tier,
          decision,
          decisionTimestamp: decisionAt,
          approvalAmount: approvalAmt ? new Prisma.Decimal(approvalAmt) : null,
          apr: apr ? new Prisma.Decimal(apr) : null,
          term: decision === 'APPROVED' ? rand([12, 24, 36, 48, 60]) : null,
          fundingStatus: status === 'FUNDED' ? 'FUNDED' : 'PENDING',
          fundingTimestamp:
            status === 'FUNDED' ? new Date(decisionAt.getTime() + 24 * 60 * 60_000) : null,
          fundingAmount:
            status === 'FUNDED' && approvalAmt ? new Prisma.Decimal(approvalAmt) : null,
        },
      });

      if (status === 'FUNDED' && approvalAmt) {
        const eazepayCut = approvalAmt * 0.05; // 5% origination-share placeholder
        await prisma.revenueEvent.create({
          data: {
            orgId,
            partnerId: partner.id,
            lenderDecisionId: decisionRow.id,
            source: 'BUZZPAY',
            stream: 'BUZZPAY',
            eventType: 'FUNDING',
            amount: new Prisma.Decimal(eazepayCut.toFixed(2)),
            effectiveAt: decisionRow.fundingTimestamp!,
            idempotencyKey: `seed:buzzpay:funding:${decisionRow.id}`,
            metadata: {},
          },
        });
        // 5% chance of clawback.
        if (Math.random() < 0.05) {
          await prisma.revenueEvent.create({
            data: {
              orgId,
              partnerId: partner.id,
              lenderDecisionId: decisionRow.id,
              source: 'BUZZPAY',
              stream: 'BUZZPAY',
              eventType: 'CLAWBACK',
              amount: new Prisma.Decimal((-eazepayCut).toFixed(2)),
              effectiveAt: new Date(decisionRow.fundingTimestamp!.getTime() + 30 * 86_400_000),
              idempotencyKey: `seed:buzzpay:clawback:${decisionRow.id}`,
              metadata: { reason: 'Default within 30 days' },
            },
          });
        }
      }
    }
  }

  // ─── Pixie metrics (30 days) ──────────────────────────────────────────────
  for (let day = 0; day < 30; day += 1) {
    const periodStart = new Date(Date.now() - day * 86_400_000);
    periodStart.setUTCHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart.getTime() + 86_399_999);
    const collective = rangeInt(20_000, 30_000);

    for (const p of partners) {
      const partnerPulls = Math.floor(collective * (rangeInt(40, 120) / 1000));
      const margin = computePixieMargin({
        collectivePulls: collective,
        partnerPulls,
        breakpoint: 25_000,
        baseCost: 1.0,
        baseCharge: 3.0,
      });
      await prisma.pixieMetric.upsert({
        where: { periodStart_partnerId_period: { periodStart, partnerId: p.id, period: 'DAILY' } },
        create: {
          orgId,
          partnerId: p.id,
          period: 'DAILY',
          periodStart,
          periodEnd,
          dataPullsThisPeriod: partnerPulls,
          dataPullsCumulative: partnerPulls * (30 - day),
          costPerPull: new Prisma.Decimal(margin.costPerPull),
          chargePerPull: new Prisma.Decimal(margin.chargePerPull),
          profitPerPull: new Prisma.Decimal(margin.marginPerPull),
          totalRevenue: new Prisma.Decimal(margin.total),
          volumeThreshold: 25_000,
          volumeAchieved: collective,
        },
        update: {},
      });

      if (Number(margin.total) > 0) {
        await prisma.revenueEvent.upsert({
          where: {
            effectiveAt_partnerId_idempotencyKey: {
              effectiveAt: periodStart,
              partnerId: p.id,
              idempotencyKey: `seed:pixie:${p.id}:${periodStart.toISOString()}`,
            },
          },
          create: {
            orgId,
            partnerId: p.id,
            source: 'PIXIE',
            stream: 'PIXIE',
            eventType: 'PIXIE_MARGIN',
            amount: new Prisma.Decimal(margin.total),
            effectiveAt: periodStart,
            idempotencyKey: `seed:pixie:${p.id}:${periodStart.toISOString()}`,
            metadata: { pulls: partnerPulls, collective },
          },
          update: {},
        });
      }
    }
  }

  console.log('✓ seed complete');
}

function pickWeighted<T extends string>(weights: ReadonlyArray<readonly [T, number]>): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of weights) {
    r -= w;
    if (r <= 0) return v;
  }
  return weights[0]![0];
}

main()
  .catch((err) => {
    console.error('seed failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
