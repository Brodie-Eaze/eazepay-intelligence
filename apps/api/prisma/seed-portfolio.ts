/**
 * Portfolio demo seed.
 *
 * Populates the portfolio_* tables with deterministic mock data so a
 * fresh dev / staging environment shows the holdco surface end-to-end
 * without waiting for a real silo to wire up.
 *
 * Replaces the in-memory `Map`-backed fixtures that lived in
 * `apps/api/src/domains/portfolio/portfolio.fixtures.ts` (now removed).
 * The seeded shape matches the live ingestion contract — once a real
 * silo's accounting feed lands, you can `prisma migrate reset` + run
 * the live ingestion endpoints, no schema change required.
 *
 * Run:  pnpm --filter api exec tsx prisma/seed-portfolio.ts
 */
import { PrismaClient, type PortfolioBusinessStatus } from '@prisma/client';
import { PortfolioRepository } from '../src/domains/portfolio/portfolio.repository.js';

interface SeedVertical {
  slug: 'coaching' | 'medical' | 'home-improvement';
  name: string;
  description: string;
}

interface SeedBusiness {
  slug: string;
  name: string;
  vertical: SeedVertical['slug'];
  status: PortfolioBusinessStatus;
  acquiredAt: string;
  ownershipPct: number;
  hqRegion: string;
  segment: string;
  fteCount: number;
  ttmRevenue: number;
  ttmEbitda: number;
  ttmGrossProfit: number;
  arr: number;
  nrr: number;
  grossMargin: number;
  cashOnHand: number;
  netDebt: number;
}

const VERTICALS: SeedVertical[] = [
  {
    slug: 'coaching',
    name: 'Coaching',
    description: 'Online education and high-ticket coaching programs.',
  },
  {
    slug: 'medical',
    name: 'Medical',
    description: 'Clinics, aesthetics, and elective medical service providers.',
  },
  {
    slug: 'home-improvement',
    name: 'Home improvement',
    description: 'Home services, remodelling, and contractor businesses.',
  },
];

const BUSINESSES: SeedBusiness[] = [
  {
    slug: 'apex-coaching',
    name: 'Apex Coaching',
    vertical: 'coaching',
    status: 'ACTIVE',
    acquiredAt: '2024-08-01',
    ownershipPct: 0.85,
    hqRegion: 'US-NY',
    segment: 'Sales coaching',
    fteCount: 28,
    ttmRevenue: 14_200_000,
    ttmEbitda: 3_950_000,
    ttmGrossProfit: 11_300_000,
    arr: 9_800_000,
    nrr: 1.18,
    grossMargin: 0.795,
    cashOnHand: 2_400_000,
    netDebt: -800_000,
  },
  {
    slug: 'northstar-mentors',
    name: 'NorthStar Mentors',
    vertical: 'coaching',
    status: 'INTEGRATING',
    acquiredAt: '2025-11-12',
    ownershipPct: 0.6,
    hqRegion: 'US-CA',
    segment: 'Career coaching',
    fteCount: 12,
    ttmRevenue: 4_350_000,
    ttmEbitda: 720_000,
    ttmGrossProfit: 2_960_000,
    arr: 2_900_000,
    nrr: 1.04,
    grossMargin: 0.681,
    cashOnHand: 320_000,
    netDebt: 410_000,
  },
  {
    slug: 'meridian-aesthetics',
    name: 'Meridian Aesthetics',
    vertical: 'medical',
    status: 'ACTIVE',
    acquiredAt: '2023-04-22',
    ownershipPct: 1,
    hqRegion: 'US-FL',
    segment: 'Aesthetic medicine',
    fteCount: 64,
    ttmRevenue: 22_800_000,
    ttmEbitda: 6_100_000,
    ttmGrossProfit: 13_900_000,
    arr: 0,
    nrr: 0.94,
    grossMargin: 0.61,
    cashOnHand: 5_600_000,
    netDebt: -1_900_000,
  },
  {
    slug: 'helix-dental-group',
    name: 'Helix Dental Group',
    vertical: 'medical',
    status: 'ACTIVE',
    acquiredAt: '2024-02-09',
    ownershipPct: 0.72,
    hqRegion: 'US-TX',
    segment: 'Dental & ortho',
    fteCount: 41,
    ttmRevenue: 11_900_000,
    ttmEbitda: 2_180_000,
    ttmGrossProfit: 6_800_000,
    arr: 0,
    nrr: 0.91,
    grossMargin: 0.571,
    cashOnHand: 1_350_000,
    netDebt: 950_000,
  },
  {
    slug: 'silverline-renovations',
    name: 'Silverline Renovations',
    vertical: 'home-improvement',
    status: 'ACTIVE',
    acquiredAt: '2024-05-30',
    ownershipPct: 0.7,
    hqRegion: 'US-IL',
    segment: 'Bathroom remodel',
    fteCount: 88,
    ttmRevenue: 31_400_000,
    ttmEbitda: 4_700_000,
    ttmGrossProfit: 12_200_000,
    arr: 0,
    nrr: 0.88,
    grossMargin: 0.388,
    cashOnHand: 2_900_000,
    netDebt: 4_200_000,
  },
  {
    slug: 'pinepoint-roofing',
    name: 'Pinepoint Roofing',
    vertical: 'home-improvement',
    status: 'PROSPECT',
    acquiredAt: '2026-04-01',
    ownershipPct: 0,
    hqRegion: 'US-CO',
    segment: 'Residential roofing',
    fteCount: 36,
    ttmRevenue: 9_700_000,
    ttmEbitda: 1_320_000,
    ttmGrossProfit: 3_400_000,
    arr: 0,
    nrr: 0.9,
    grossMargin: 0.351,
    cashOnHand: 480_000,
    netDebt: 1_100_000,
  },
];

// ─── Deterministic generators ──────────────────────────────────────────────
// Same seeded RNG as the v0 fixtures so dev screenshots stay reproducible.

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMonthlyPnl(
  b: SeedBusiness,
  months = 18,
): Array<Parameters<PortfolioRepository['replaceFinancialPeriods']>[1][number]> {
  const seed = hashSeed(b.slug);
  const rand = mulberry32(seed);
  const baseMonthly = b.ttmRevenue / 12;
  const baseGm = b.grossMargin;
  const baseEbitdaMargin = b.ttmEbitda / b.ttmRevenue;
  const out: Array<Parameters<PortfolioRepository['replaceFinancialPeriods']>[1][number]> = [];
  const today = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const trend = 1 + (months - 1 - i - months / 2) * 0.014;
    const seasonal = 1 + Math.sin((d.getUTCMonth() / 12) * Math.PI * 2) * 0.06;
    const noise = 0.92 + rand() * 0.16;
    const revenue = Math.round(baseMonthly * trend * seasonal * noise);
    const cogs = Math.round(revenue * (1 - baseGm) * (0.95 + rand() * 0.1));
    const grossProfit = revenue - cogs;
    const marketingSpend = Math.round(revenue * (0.09 + rand() * 0.04));
    const payroll = Math.round(revenue * (0.22 + rand() * 0.05));
    const rentAndUtilities = Math.round(revenue * (0.025 + rand() * 0.01));
    const softwareAndTools = Math.round(revenue * (0.018 + rand() * 0.006));
    const professionalServices = Math.round(revenue * (0.015 + rand() * 0.008));
    const otherOpex = Math.round(revenue * (0.025 + rand() * 0.012));
    const totalOpex =
      marketingSpend +
      payroll +
      rentAndUtilities +
      softwareAndTools +
      professionalServices +
      otherOpex;
    const ebitda = Math.round(grossProfit - totalOpex);
    const ebitdaAdj = Math.round((revenue * baseEbitdaMargin - ebitda) * 0.6);
    const ebitdaFinal = ebitda + ebitdaAdj;
    const depreciation = Math.round(revenue * 0.02);
    const interest = Math.round((Math.max(0, b.netDebt) * 0.06) / 12);
    const preTax = ebitdaFinal - depreciation - interest;
    const tax = Math.round(Math.max(0, preTax) * 0.25);
    const netIncome = preTax - tax;
    const cashIn = Math.round(revenue * (0.96 + rand() * 0.06));
    const cashOut = Math.round((cogs + totalOpex + interest + tax) * (0.98 + rand() * 0.04));
    const arBalance = Math.round(revenue * (0.18 + rand() * 0.05));
    const apBalance = Math.round((cogs + totalOpex) * (0.12 + rand() * 0.04));
    out.push({
      periodStart: d,
      periodLabel: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      revenue,
      cogs,
      grossProfit,
      marketingSpend,
      payroll,
      rentAndUtilities,
      softwareAndTools,
      professionalServices,
      otherOpex,
      ebitda: ebitdaFinal,
      depreciation,
      interest,
      tax,
      netIncome,
      cashIn,
      cashOut,
      arBalance,
      apBalance,
    });
  }
  return out;
}

function generateChannels(
  b: SeedBusiness,
): Array<{ channel: string; revenue: number; customers: number; share: number }> {
  const seed = hashSeed(`${b.slug}::channels`);
  const rand = mulberry32(seed);
  const channels =
    b.vertical === 'coaching'
      ? ['Paid social', 'Webinar funnel', 'Affiliates', 'Organic', 'Referral']
      : b.vertical === 'medical'
        ? ['Walk-in', 'Referral', 'Paid search', 'Insurance', 'Corporate plans']
        : ['Door-to-door', 'Paid search', 'Trade shows', 'Referral', 'Direct mail'];
  const weights = channels.map(() => rand() + 0.3);
  const sumW = weights.reduce((s, w) => s + w, 0);
  return channels.map((channel, i) => {
    const share = weights[i]! / sumW;
    return {
      channel,
      revenue: Math.round(b.ttmRevenue * share),
      customers: Math.round((b.ttmRevenue * share) / (200 + rand() * 1800)),
      share,
    };
  });
}

function generateProducts(
  b: SeedBusiness,
): Array<{ name: string; revenue: number; units: number; avgPrice: number }> {
  const seed = hashSeed(`${b.slug}::products`);
  const rand = mulberry32(seed);
  const lines =
    b.vertical === 'coaching'
      ? ['Foundations 8-week', 'Mastermind annual', 'VIP coaching', '1:1 Strategy']
      : b.vertical === 'medical'
        ? ['Consults', 'Procedures', 'Skincare retail', 'Memberships']
        : ['Bathroom reno', 'Kitchen reno', 'Maintenance plan', 'Add-ons'];
  const weights = lines.map(() => rand() + 0.4);
  const sumW = weights.reduce((s, w) => s + w, 0);
  return lines.map((name, i) => {
    const revenue = Math.round(b.ttmRevenue * (weights[i]! / sumW) * (0.92 + rand() * 0.12));
    const avgPrice = Math.round(150 + rand() * 7500);
    return { name, revenue, units: Math.max(1, Math.round(revenue / avgPrice)), avgPrice };
  });
}

function generateUnitEconomics(b: SeedBusiness): {
  cac: number;
  ltv: number;
  paybackMonths: number;
  arpu: number;
  grossMargin: number;
  nrr: number;
  churnMonthly: number;
} {
  const seed = hashSeed(`${b.slug}::ue`);
  const rand = mulberry32(seed);
  const cac = Math.round(180 + rand() * 1800);
  const ltv = Math.round(cac * (2.4 + rand() * 4.5));
  const paybackMonths = Math.max(1, Math.round(cac / (ltv / 24)));
  const arpu = Math.round(ltv / (12 + rand() * 18));
  return {
    cac,
    ltv,
    paybackMonths,
    arpu,
    grossMargin: b.grossMargin,
    nrr: b.nrr,
    churnMonthly: Math.max(0.005, 0.04 - b.nrr * 0.025),
  };
}

function generateCohorts(
  b: SeedBusiness,
): Array<{
  cohortMonth: Date;
  customers: number;
  m0: number;
  m3: number;
  m6: number;
  m12: number;
}> {
  const seed = hashSeed(`${b.slug}::cohorts`);
  const rand = mulberry32(seed);
  const today = new Date();
  return Array.from({ length: 12 }, (_, idx) => {
    const i = 11 - idx;
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    return {
      cohortMonth: d,
      customers: Math.round(80 + rand() * 380),
      m0: 1,
      m3: +(0.62 + rand() * 0.2).toFixed(2),
      m6: +(0.42 + rand() * 0.18).toFixed(2),
      m12: +(0.28 + rand() * 0.14).toFixed(2),
    };
  });
}

function generateHeadcount(
  b: SeedBusiness,
): Array<{ function: string; ftes: number; payrollMonthly: number; openRoles: number }> {
  const seed = hashSeed(`${b.slug}::hc`);
  const rand = mulberry32(seed);
  const fns =
    b.vertical === 'medical'
      ? ['Clinical', 'Front-of-house', 'Sales', 'Marketing', 'Operations', 'Finance', 'Tech']
      : b.vertical === 'home-improvement'
        ? ['Field crews', 'Sales', 'Estimating', 'Operations', 'Marketing', 'Finance']
        : ['Coaching', 'Sales', 'Marketing', 'Customer success', 'Operations', 'Finance', 'Tech'];
  const weights = fns.map(() => rand() + 0.4);
  const sumW = weights.reduce((s, w) => s + w, 0);
  return fns.map((fn, i) => {
    const ftes = Math.max(1, Math.round((weights[i]! / sumW) * b.fteCount));
    return {
      function: fn,
      ftes,
      payrollMonthly: Math.round(ftes * (5_500 + rand() * 6_500)),
      openRoles: rand() < 0.4 ? Math.floor(rand() * 3) : 0,
    };
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const repo = new PortfolioRepository(prisma);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  console.log('[seed-portfolio] verticals');
  for (const v of VERTICALS) await repo.upsertVertical(v);

  console.log('[seed-portfolio] businesses + financials');
  for (const b of BUSINESSES) {
    await repo.upsertBusiness({
      slug: b.slug,
      name: b.name,
      verticalSlug: b.vertical,
      status: b.status,
      acquiredAt: new Date(b.acquiredAt),
      ownershipPct: b.ownershipPct,
      hqRegion: b.hqRegion,
      segment: b.segment,
      fteCount: b.fteCount,
      ttmRevenue: b.ttmRevenue,
      ttmEbitda: b.ttmEbitda,
      ttmGrossProfit: b.ttmGrossProfit,
      arr: b.arr,
      nrr: b.nrr,
      grossMargin: b.grossMargin,
      cashOnHand: b.cashOnHand,
      netDebt: b.netDebt,
    });
    await repo.replaceFinancialPeriods(b.slug, generateMonthlyPnl(b));
    await repo.replaceChannels(b.slug, today, generateChannels(b));
    await repo.replaceProducts(b.slug, today, generateProducts(b));
    await repo.upsertUnitEconomics(b.slug, { asOf: today, ...generateUnitEconomics(b) });
    await repo.replaceCohorts(b.slug, generateCohorts(b));
    await repo.replaceHeadcount(b.slug, today, generateHeadcount(b));
    console.log(`[seed-portfolio]   ${b.slug}: pnl + revenue + ue + cohorts + headcount`);
  }

  console.log('[seed-portfolio] done');
  await prisma.$disconnect();
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed-portfolio] failed', err);
  process.exit(1);
});
