/**
 * Seed Brodie's five operating businesses as PortfolioBusiness rows so
 * they appear in the holdco rollup UI (`apps/web/src/app/(app)/portfolio/`).
 *
 * Distinct from `seed-portfolio-orgs.ts`:
 *   - That script creates `Organization` rows (the tenant model: who logs in).
 *   - This script creates `PortfolioBusiness` rows (the holdco model: businesses
 *     whose financials roll up to Brodie's portfolio view).
 *
 * Both are needed: a business is both a tenant (its team logs in to see its
 * own data) AND a portfolio business (its financials feed Brodie's rollup).
 *
 * Placeholder financials — replace with real numbers via the portfolio
 * ingestion API once the businesses start reporting.
 *
 * Idempotent: upserts by slug.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VERTICALS = [
  {
    slug: 'aurean-holdings',
    name: 'Aurean Holdings',
    description: 'AI ops + recruitment subsidiaries that power the Aurean group.',
  },
  {
    slug: 'point-of-sale-bnpl',
    name: 'Point-of-sale BNPL',
    description: 'Vertical BNPL plays in coach, trade, and medical/dental services.',
  },
  {
    slug: 'payments-infrastructure',
    name: 'Payments infrastructure',
    description: 'Card processing (MiCamp) + credit-data scoring (HighSale / EZ Check).',
  },
];

// Realistic TTM financials for the holdco view. These are demo numbers
// (Sprint B), but tuned to plausible AUD figures for each segment so the
// portfolio rollup stops showing all-zeros when only the lightweight
// businesses seed has run. Replace via the real portfolio ingestion API
// once each entity starts reporting actuals.
//
// All AUD; non-round on purpose so the KPI tiles never read "$1,000,000".
const BUSINESSES = [
  {
    slug: 'medpay',
    name: 'MedPay',
    verticalSlug: 'point-of-sale-bnpl',
    segment: 'Medical / dental BNPL',
    hqRegion: 'Sydney, AU',
    fteCount: 4,
    currency: 'AUD',
    ttmRevenue: 2_847_300,
    ttmEbitda: 412_500,
    ttmGrossProfit: 1_566_000,
    arr: 1_924_800,
    nrr: 1.08,
    grossMargin: 0.55,
    cashOnHand: 638_400,
    netDebt: -210_500,
    ownershipPct: 1.0,
    acquiredAt: '2025-06-01',
  },
  {
    slug: 'tradepay',
    name: 'TradePay',
    verticalSlug: 'point-of-sale-bnpl',
    segment: 'Trade services BNPL',
    hqRegion: 'Sydney, AU',
    fteCount: 5,
    currency: 'AUD',
    ttmRevenue: 3_612_400,
    ttmEbitda: 587_900,
    ttmGrossProfit: 1_986_800,
    arr: 2_488_200,
    nrr: 1.11,
    grossMargin: 0.55,
    cashOnHand: 824_700,
    netDebt: -118_300,
    ownershipPct: 1.0,
    acquiredAt: '2025-06-01',
  },
  {
    slug: 'coachpay',
    name: 'CoachPay',
    verticalSlug: 'point-of-sale-bnpl',
    segment: 'Coaching BNPL',
    hqRegion: 'Sydney, AU',
    fteCount: 6,
    currency: 'AUD',
    ttmRevenue: 1_983_650,
    ttmEbitda: 248_900,
    ttmGrossProfit: 1_091_000,
    arr: 1_412_300,
    nrr: 1.04,
    grossMargin: 0.55,
    cashOnHand: 392_500,
    netDebt: 0,
    ownershipPct: 1.0,
    acquiredAt: '2025-06-01',
  },
  {
    slug: 'aurean-ai',
    name: 'Aurean AI',
    verticalSlug: 'aurean-holdings',
    segment: 'AI operations',
    hqRegion: 'Sydney, AU',
    fteCount: 12,
    currency: 'AUD',
    ttmRevenue: 4_726_900,
    ttmEbitda: 1_158_400,
    ttmGrossProfit: 3_072_500,
    arr: 4_087_200,
    nrr: 1.18,
    grossMargin: 0.65,
    cashOnHand: 1_847_600,
    netDebt: -512_000,
    ownershipPct: 1.0,
    acquiredAt: '2025-01-01',
  },
  {
    slug: 'aurean-recruitment',
    name: 'Aurean Recruitment',
    verticalSlug: 'aurean-holdings',
    segment: 'Talent placement',
    hqRegion: 'Sydney, AU',
    fteCount: 18,
    currency: 'AUD',
    ttmRevenue: 6_341_200,
    ttmEbitda: 894_700,
    ttmGrossProfit: 2_663_300,
    arr: 4_812_500,
    nrr: 0.97,
    grossMargin: 0.42,
    cashOnHand: 1_204_900,
    netDebt: 308_700,
    ownershipPct: 1.0,
    acquiredAt: '2025-01-01',
  },
  {
    slug: 'micamp-processing',
    name: 'MiCamp Processing',
    verticalSlug: 'payments-infrastructure',
    segment: 'Card-processing rail',
    hqRegion: 'Sydney, AU',
    fteCount: 8,
    currency: 'AUD',
    ttmRevenue: 5_184_700,
    ttmEbitda: 743_200,
    ttmGrossProfit: 2_333_100,
    arr: 3_726_400,
    nrr: 1.12,
    grossMargin: 0.45,
    cashOnHand: 968_400,
    netDebt: -94_200,
    ownershipPct: 1.0,
    acquiredAt: '2025-06-01',
  },
  {
    slug: 'highsale',
    name: 'HighSale',
    verticalSlug: 'payments-infrastructure',
    segment: 'Credit-data scoring (EZ Check)',
    hqRegion: 'Sydney, AU',
    fteCount: 4,
    currency: 'AUD',
    ttmRevenue: 1_276_800,
    ttmEbitda: 318_400,
    ttmGrossProfit: 893_760,
    arr: 982_500,
    nrr: 1.22,
    grossMargin: 0.7,
    cashOnHand: 442_900,
    netDebt: 0,
    ownershipPct: 1.0,
    acquiredAt: '2025-06-01',
  },
];

async function main(): Promise<void> {
  console.log('[portfolio-businesses] starting');

  for (const v of VERTICALS) {
    await prisma.portfolioVertical.upsert({
      where: { slug: v.slug },
      update: { name: v.name, description: v.description },
      create: v,
    });
    console.log(`  vertical: ${v.slug}`);
  }

  for (const b of BUSINESSES) {
    await prisma.portfolioBusiness.upsert({
      where: { slug: b.slug },
      update: {
        name: b.name,
        verticalSlug: b.verticalSlug,
        segment: b.segment,
      },
      create: {
        ...b,
        status: 'ACTIVE',
        acquiredAt: new Date(b.acquiredAt),
      },
    });
    console.log(`  business: ${b.slug} (${b.verticalSlug})`);
  }

  console.log('[portfolio-businesses] done');
}

main()
  .catch((e) => {
    console.error('[portfolio-businesses] error', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
