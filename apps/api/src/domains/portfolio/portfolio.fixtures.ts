/**
 * Portfolio fixtures.
 *
 * This is the in-memory mock layer for the portfolio surface. Every shape here
 * mirrors what the eventual ingestion pipeline will populate (per-silo
 * accounting feed → normalised financial periods → portfolio aggregates).
 *
 * Treating this as a real data source from day one means the route layer is
 * source-agnostic — when we plug in the real ingestion, only this file
 * disappears.
 *
 * Data classification: anything below is RESTRICTED. Don't log payloads.
 */

export type VerticalSlug = 'coaching' | 'medical' | 'home-improvement';
export type BusinessStatus = 'ACTIVE' | 'INTEGRATING' | 'EXITED' | 'PROSPECT';

export interface Vertical {
  slug: VerticalSlug;
  name: string;
  description: string;
}

export interface Business {
  slug: string;
  name: string;
  vertical: VerticalSlug;
  status: BusinessStatus;
  acquiredAt: string;
  ownershipPct: number; // 0..1
  hqRegion: string;
  segment: string;
  fteCount: number;
  // Trailing-twelve-months snapshot — already computed on the silo side.
  ttmRevenue: number;
  ttmEbitda: number;
  ttmGrossProfit: number;
  arr: number;
  nrr: number; // net revenue retention 0..1
  grossMargin: number; // 0..1
  cashOnHand: number;
  netDebt: number;
}

export interface FinancialPeriod {
  periodStart: string; // ISO date, first of month
  periodLabel: string; // 'Jan 26'
  revenue: number;
  cogs: number;
  grossProfit: number;
  marketingSpend: number;
  payroll: number;
  rentAndUtilities: number;
  softwareAndTools: number;
  professionalServices: number;
  otherOpex: number;
  ebitda: number;
  depreciation: number;
  interest: number;
  tax: number;
  netIncome: number;
  cashIn: number;
  cashOut: number;
  arBalance: number;
  apBalance: number;
}

export interface RevenueChannelSlice {
  channel: string;
  revenue: number;
  customers: number;
  share: number; // 0..1
}

export interface ProductLine {
  name: string;
  revenue: number;
  units: number;
  avgPrice: number;
}

export interface UnitEconomics {
  cac: number;
  ltv: number;
  paybackMonths: number;
  grossMargin: number;
  churnMonthly: number;
  arpu: number;
  nrr: number;
}

export interface CohortRow {
  cohort: string; // 'Jan 26'
  customers: number;
  m0: number;
  m3: number;
  m6: number;
  m12: number;
}

export interface HeadcountRow {
  function: string;
  ftes: number;
  payrollMonthly: number;
  openRoles: number;
}

const VERTICALS: Vertical[] = [
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

const BUSINESSES: Business[] = [
  {
    slug: 'apex-coaching',
    name: 'Apex Coaching',
    vertical: 'coaching',
    status: 'ACTIVE',
    acquiredAt: '2024-08-01',
    ownershipPct: 0.85,
    hqRegion: 'AU-NSW',
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
    hqRegion: 'AU-VIC',
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
    hqRegion: 'AU-QLD',
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
    hqRegion: 'AU-WA',
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
    hqRegion: 'AU-NSW',
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
    hqRegion: 'AU-VIC',
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

export function listVerticals(): Vertical[] {
  return VERTICALS;
}

export function getVertical(slug: string): Vertical | null {
  return VERTICALS.find((v) => v.slug === slug) ?? null;
}

export function listBusinesses(filter?: { vertical?: VerticalSlug }): Business[] {
  if (filter?.vertical) return BUSINESSES.filter((b) => b.vertical === filter.vertical);
  return BUSINESSES;
}

export function getBusiness(slug: string): Business | null {
  return BUSINESSES.find((b) => b.slug === slug) ?? null;
}

// ─── Write side: in-memory store for the ingestion contract ─────────────
// Devs hit the POST/PATCH endpoints to push real silo data; we hold it here
// until the real persistence layer (Prisma model + ingestion worker) lands.
// All write paths funnel through these helpers so the swap-out is one file.

const PUSHED_PNL = new Map<string, FinancialPeriod[]>();
const PUSHED_CHANNELS = new Map<string, RevenueChannelSlice[]>();
const PUSHED_PRODUCTS = new Map<string, ProductLine[]>();
const PUSHED_UE = new Map<string, UnitEconomics>();
const PUSHED_COHORTS = new Map<string, CohortRow[]>();
const PUSHED_HEADCOUNT = new Map<string, HeadcountRow[]>();

export function upsertVertical(v: Vertical): Vertical {
  const i = VERTICALS.findIndex((x) => x.slug === v.slug);
  if (i >= 0) VERTICALS[i] = v;
  else VERTICALS.push(v);
  return v;
}

export function upsertBusiness(b: Business): Business {
  const i = BUSINESSES.findIndex((x) => x.slug === b.slug);
  if (i >= 0) BUSINESSES[i] = b;
  else BUSINESSES.push(b);
  return b;
}

export function patchBusiness(slug: string, patch: Partial<Business>): Business | null {
  const i = BUSINESSES.findIndex((x) => x.slug === slug);
  if (i < 0) return null;
  const merged = { ...BUSINESSES[i]!, ...patch, slug } as Business;
  BUSINESSES[i] = merged;
  return merged;
}

export function setPnl(slug: string, periods: FinancialPeriod[]): void {
  PUSHED_PNL.set(slug, periods);
}
export function getPushedPnl(slug: string): FinancialPeriod[] | undefined {
  return PUSHED_PNL.get(slug);
}

export function setChannels(slug: string, rows: RevenueChannelSlice[]): void {
  PUSHED_CHANNELS.set(slug, rows);
}
export function getPushedChannels(slug: string): RevenueChannelSlice[] | undefined {
  return PUSHED_CHANNELS.get(slug);
}

export function setProducts(slug: string, rows: ProductLine[]): void {
  PUSHED_PRODUCTS.set(slug, rows);
}
export function getPushedProducts(slug: string): ProductLine[] | undefined {
  return PUSHED_PRODUCTS.get(slug);
}

export function setUnitEconomics(slug: string, ue: UnitEconomics): void {
  PUSHED_UE.set(slug, ue);
}
export function getPushedUnitEconomics(slug: string): UnitEconomics | undefined {
  return PUSHED_UE.get(slug);
}

export function setCohorts(slug: string, rows: CohortRow[]): void {
  PUSHED_COHORTS.set(slug, rows);
}
export function getPushedCohorts(slug: string): CohortRow[] | undefined {
  return PUSHED_COHORTS.get(slug);
}

export function setHeadcount(slug: string, rows: HeadcountRow[]): void {
  PUSHED_HEADCOUNT.set(slug, rows);
}
export function getPushedHeadcount(slug: string): HeadcountRow[] | undefined {
  return PUSHED_HEADCOUNT.get(slug);
}

/**
 * Deterministic monthly P&L generator. Seeded by business slug so the same
 * business always returns the same series — important so screenshots and
 * shared links stay reproducible. When we cut over to real data, the route
 * just calls the silo accounting service instead.
 */
export function buildMonthlyPnl(b: Business, months = 18): FinancialPeriod[] {
  const seed = hashSeed(b.slug);
  const rand = mulberry32(seed);
  const baseMonthly = b.ttmRevenue / 12;
  const baseGm = b.grossMargin;
  const baseEbitdaMargin = b.ttmEbitda / b.ttmRevenue;
  const out: FinancialPeriod[] = [];

  const today = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const trend = 1 + (months - 1 - i - months / 2) * 0.014; // mild growth
    const seasonal = 1 + Math.sin((d.getMonth() / 12) * Math.PI * 2) * 0.06;
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
    // EBITDA-margin convergence — anchor toward the business' headline margin.
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
      periodStart: d.toISOString().slice(0, 10),
      periodLabel: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
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

export function buildRevenueChannels(b: Business): RevenueChannelSlice[] {
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
    const revenue = Math.round(b.ttmRevenue * share);
    const customers = Math.round((b.ttmRevenue * share) / (200 + rand() * 1800));
    return { channel, revenue, customers, share };
  });
}

export function buildProductLines(b: Business): ProductLine[] {
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
    const units = Math.max(1, Math.round(revenue / avgPrice));
    return { name, revenue, units, avgPrice };
  });
}

export function buildUnitEconomics(b: Business): UnitEconomics {
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

export function buildCohorts(b: Business): CohortRow[] {
  const seed = hashSeed(`${b.slug}::cohorts`);
  const rand = mulberry32(seed);
  const today = new Date();
  const out: CohortRow[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const customers = Math.round(80 + rand() * 380);
    const m0 = 1;
    const m3 = +(0.62 + rand() * 0.2).toFixed(2);
    const m6 = +(0.42 + rand() * 0.18).toFixed(2);
    const m12 = +(0.28 + rand() * 0.14).toFixed(2);
    out.push({
      cohort: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
      customers,
      m0,
      m3,
      m6,
      m12,
    });
  }
  return out;
}

export function buildHeadcount(b: Business): HeadcountRow[] {
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
  return fns.map((fn) => {
    const ftes = Math.max(1, Math.round((weights[fns.indexOf(fn)]! / sumW) * b.fteCount));
    const payrollMonthly = Math.round(ftes * (5_500 + rand() * 6_500));
    const openRoles = Math.random() < 0.4 ? Math.floor(rand() * 3) : 0;
    return { function: fn, ftes, payrollMonthly, openRoles };
  });
}

// --- helpers --------------------------------------------------------------

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
