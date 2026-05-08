/**
 * Portfolio repository — durable Prisma-backed persistence for the silos
 * surface. Replaces the in-memory `Map`-backed store that lived in
 * `portfolio.fixtures.ts`.
 *
 * Two clients per instance:
 *   - writer  → mutations (verticals, businesses, P&L, channels, etc.)
 *   - reader  → list / get queries (replica when DATABASE_REPLICA_URL set)
 *
 * The shape returned mirrors the v0 fixture types so the route layer can
 * swap implementations without touching response contracts. New columns
 * (currency on Business) are additive.
 */
import { v7 as uuidv7 } from 'uuid';
import type {
  PrismaClient,
  PortfolioBusiness,
  PortfolioBusinessStatus,
  PortfolioCohort,
  PortfolioFinancialPeriod,
  PortfolioHeadcount,
  PortfolioProductLine,
  PortfolioRevenueChannel,
  PortfolioUnitEconomics,
  PortfolioVertical,
} from '@prisma/client';

export interface BusinessUpsertInput {
  slug: string;
  name: string;
  verticalSlug: string;
  status: PortfolioBusinessStatus;
  acquiredAt: Date;
  ownershipPct: string | number;
  hqRegion: string;
  segment: string;
  fteCount: number;
  currency?: string;
  ttmRevenue: string | number;
  ttmEbitda: string | number;
  ttmGrossProfit: string | number;
  arr?: string | number;
  nrr: string | number;
  grossMargin: string | number;
  cashOnHand: string | number;
  netDebt: string | number;
}

export interface FinancialPeriodInput {
  periodStart: Date;
  periodLabel: string;
  revenue: string | number;
  cogs: string | number;
  grossProfit: string | number;
  marketingSpend: string | number;
  payroll: string | number;
  rentAndUtilities: string | number;
  softwareAndTools: string | number;
  professionalServices: string | number;
  otherOpex: string | number;
  ebitda: string | number;
  depreciation: string | number;
  interest: string | number;
  tax: string | number;
  netIncome: string | number;
  cashIn: string | number;
  cashOut: string | number;
  arBalance: string | number;
  apBalance: string | number;
}

export interface RevenueChannelInput {
  channel: string;
  revenue: string | number;
  customers: number;
  share: string | number;
}

export interface ProductLineInput {
  name: string;
  revenue: string | number;
  units: number;
  avgPrice: string | number;
}

export interface UnitEconomicsInput {
  asOf: Date;
  cac: string | number;
  ltv: string | number;
  paybackMonths: string | number;
  arpu: string | number;
  grossMargin: string | number;
  nrr: string | number;
  churnMonthly: string | number;
}

export interface CohortInput {
  cohortMonth: Date;
  customers: number;
  m0: string | number;
  m3: string | number;
  m6: string | number;
  m12: string | number;
}

export interface HeadcountInput {
  function: string;
  ftes: number;
  payrollMonthly: string | number;
  openRoles: number;
}

export class PortfolioRepository {
  /**
   * `writer` carries every mutation; `reader` answers list/get queries
   * (replica when configured, falls back to writer otherwise — see
   * `config/database.ts`). Routes typically pass the same client for
   * both in single-DB deployments.
   */
  constructor(
    private readonly writer: PrismaClient,
    private readonly reader: PrismaClient = writer,
  ) {}

  // ─── Verticals ─────────────────────────────────────────────────────────

  listVerticals(): Promise<PortfolioVertical[]> {
    return this.reader.portfolioVertical.findMany({ orderBy: { name: 'asc' } });
  }

  getVertical(slug: string): Promise<PortfolioVertical | null> {
    return this.reader.portfolioVertical.findUnique({ where: { slug } });
  }

  upsertVertical(input: {
    slug: string;
    name: string;
    description?: string;
  }): Promise<PortfolioVertical> {
    return this.writer.portfolioVertical.upsert({
      where: { slug: input.slug },
      create: { slug: input.slug, name: input.name, description: input.description ?? '' },
      update: { name: input.name, description: input.description ?? '' },
    });
  }

  // ─── Businesses ────────────────────────────────────────────────────────

  listBusinesses(filter?: { vertical?: string }): Promise<PortfolioBusiness[]> {
    return this.reader.portfolioBusiness.findMany({
      where: filter?.vertical ? { verticalSlug: filter.vertical } : {},
      orderBy: { name: 'asc' },
    });
  }

  getBusiness(slug: string): Promise<PortfolioBusiness | null> {
    return this.reader.portfolioBusiness.findUnique({ where: { slug } });
  }

  upsertBusiness(input: BusinessUpsertInput): Promise<PortfolioBusiness> {
    const data = {
      name: input.name,
      verticalSlug: input.verticalSlug,
      status: input.status,
      acquiredAt: input.acquiredAt,
      ownershipPct: input.ownershipPct.toString(),
      hqRegion: input.hqRegion,
      segment: input.segment,
      fteCount: input.fteCount,
      currency: (input.currency ?? 'USD').toUpperCase(),
      ttmRevenue: input.ttmRevenue.toString(),
      ttmEbitda: input.ttmEbitda.toString(),
      ttmGrossProfit: input.ttmGrossProfit.toString(),
      arr: (input.arr ?? 0).toString(),
      nrr: input.nrr.toString(),
      grossMargin: input.grossMargin.toString(),
      cashOnHand: input.cashOnHand.toString(),
      netDebt: input.netDebt.toString(),
    };
    return this.writer.portfolioBusiness.upsert({
      where: { slug: input.slug },
      create: { slug: input.slug, ...data },
      update: data,
    });
  }

  patchBusiness(
    slug: string,
    patch: Partial<BusinessUpsertInput>,
  ): Promise<PortfolioBusiness | null> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.verticalSlug !== undefined) data.verticalSlug = patch.verticalSlug;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.acquiredAt !== undefined) data.acquiredAt = patch.acquiredAt;
    if (patch.ownershipPct !== undefined) data.ownershipPct = patch.ownershipPct.toString();
    if (patch.hqRegion !== undefined) data.hqRegion = patch.hqRegion;
    if (patch.segment !== undefined) data.segment = patch.segment;
    if (patch.fteCount !== undefined) data.fteCount = patch.fteCount;
    if (patch.currency !== undefined) data.currency = patch.currency.toUpperCase();
    if (patch.ttmRevenue !== undefined) data.ttmRevenue = patch.ttmRevenue.toString();
    if (patch.ttmEbitda !== undefined) data.ttmEbitda = patch.ttmEbitda.toString();
    if (patch.ttmGrossProfit !== undefined) data.ttmGrossProfit = patch.ttmGrossProfit.toString();
    if (patch.arr !== undefined) data.arr = patch.arr.toString();
    if (patch.nrr !== undefined) data.nrr = patch.nrr.toString();
    if (patch.grossMargin !== undefined) data.grossMargin = patch.grossMargin.toString();
    if (patch.cashOnHand !== undefined) data.cashOnHand = patch.cashOnHand.toString();
    if (patch.netDebt !== undefined) data.netDebt = patch.netDebt.toString();
    if (Object.keys(data).length === 0) return this.getBusiness(slug);
    return this.writer.portfolioBusiness.update({ where: { slug }, data }).catch(() => null);
  }

  // ─── Financial periods ────────────────────────────────────────────────

  listFinancialPeriods(slug: string): Promise<PortfolioFinancialPeriod[]> {
    return this.reader.portfolioFinancialPeriod.findMany({
      where: { businessSlug: slug },
      orderBy: { periodStart: 'asc' },
    });
  }

  async replaceFinancialPeriods(slug: string, periods: FinancialPeriodInput[]): Promise<number> {
    // Replace-set semantics: clear then bulk insert. Atomic via $transaction.
    return this.writer.$transaction(async (tx) => {
      await tx.portfolioFinancialPeriod.deleteMany({ where: { businessSlug: slug } });
      if (periods.length === 0) return 0;
      await tx.portfolioFinancialPeriod.createMany({
        data: periods.map((p) => ({
          id: uuidv7(),
          businessSlug: slug,
          periodStart: p.periodStart,
          periodLabel: p.periodLabel,
          revenue: p.revenue.toString(),
          cogs: p.cogs.toString(),
          grossProfit: p.grossProfit.toString(),
          marketingSpend: p.marketingSpend.toString(),
          payroll: p.payroll.toString(),
          rentAndUtilities: p.rentAndUtilities.toString(),
          softwareAndTools: p.softwareAndTools.toString(),
          professionalServices: p.professionalServices.toString(),
          otherOpex: p.otherOpex.toString(),
          ebitda: p.ebitda.toString(),
          depreciation: p.depreciation.toString(),
          interest: p.interest.toString(),
          tax: p.tax.toString(),
          netIncome: p.netIncome.toString(),
          cashIn: p.cashIn.toString(),
          cashOut: p.cashOut.toString(),
          arBalance: p.arBalance.toString(),
          apBalance: p.apBalance.toString(),
        })),
      });
      return periods.length;
    });
  }

  // ─── Revenue channels + product lines ─────────────────────────────────

  async getLatestChannels(slug: string): Promise<PortfolioRevenueChannel[]> {
    const latest = await this.reader.portfolioRevenueChannel.findFirst({
      where: { businessSlug: slug },
      orderBy: { asOf: 'desc' },
      select: { asOf: true },
    });
    if (!latest) return [];
    return this.reader.portfolioRevenueChannel.findMany({
      where: { businessSlug: slug, asOf: latest.asOf },
      orderBy: { revenue: 'desc' },
    });
  }

  async getLatestProducts(slug: string): Promise<PortfolioProductLine[]> {
    const latest = await this.reader.portfolioProductLine.findFirst({
      where: { businessSlug: slug },
      orderBy: { asOf: 'desc' },
      select: { asOf: true },
    });
    if (!latest) return [];
    return this.reader.portfolioProductLine.findMany({
      where: { businessSlug: slug, asOf: latest.asOf },
      orderBy: { revenue: 'desc' },
    });
  }

  async replaceChannels(
    slug: string,
    asOf: Date,
    channels: RevenueChannelInput[],
  ): Promise<number> {
    return this.writer.$transaction(async (tx) => {
      await tx.portfolioRevenueChannel.deleteMany({ where: { businessSlug: slug, asOf } });
      if (channels.length === 0) return 0;
      await tx.portfolioRevenueChannel.createMany({
        data: channels.map((c) => ({
          id: uuidv7(),
          businessSlug: slug,
          asOf,
          channel: c.channel,
          revenue: c.revenue.toString(),
          customers: c.customers,
          share: c.share.toString(),
        })),
      });
      return channels.length;
    });
  }

  async replaceProducts(slug: string, asOf: Date, products: ProductLineInput[]): Promise<number> {
    return this.writer.$transaction(async (tx) => {
      await tx.portfolioProductLine.deleteMany({ where: { businessSlug: slug, asOf } });
      if (products.length === 0) return 0;
      await tx.portfolioProductLine.createMany({
        data: products.map((p) => ({
          id: uuidv7(),
          businessSlug: slug,
          asOf,
          name: p.name,
          revenue: p.revenue.toString(),
          units: p.units,
          avgPrice: p.avgPrice.toString(),
        })),
      });
      return products.length;
    });
  }

  /**
   * Atomic replace of both channels + products for a silo at a single asOf.
   * Channels and products are a logical unit on the revenue surface — if
   * one half lands and the other doesn't, the silo's revenue panel shows
   * mismatched snapshots. The route layer used to call replaceChannels +
   * replaceProducts via Promise.all, which violated this invariant. This
   * method wraps both in one transaction so a partial failure rolls back
   * to the previous snapshot atomically.
   */
  async replaceRevenue(
    slug: string,
    asOf: Date,
    channels: RevenueChannelInput[],
    products: ProductLineInput[],
  ): Promise<{ channels: number; products: number }> {
    return this.writer.$transaction(async (tx) => {
      await tx.portfolioRevenueChannel.deleteMany({ where: { businessSlug: slug, asOf } });
      await tx.portfolioProductLine.deleteMany({ where: { businessSlug: slug, asOf } });
      if (channels.length > 0) {
        await tx.portfolioRevenueChannel.createMany({
          data: channels.map((c) => ({
            id: uuidv7(),
            businessSlug: slug,
            asOf,
            channel: c.channel,
            revenue: c.revenue.toString(),
            customers: c.customers,
            share: c.share.toString(),
          })),
        });
      }
      if (products.length > 0) {
        await tx.portfolioProductLine.createMany({
          data: products.map((p) => ({
            id: uuidv7(),
            businessSlug: slug,
            asOf,
            name: p.name,
            revenue: p.revenue.toString(),
            units: p.units,
            avgPrice: p.avgPrice.toString(),
          })),
        });
      }
      return { channels: channels.length, products: products.length };
    });
  }

  // ─── Unit economics ────────────────────────────────────────────────────

  getUnitEconomics(slug: string): Promise<PortfolioUnitEconomics | null> {
    return this.reader.portfolioUnitEconomics.findUnique({ where: { businessSlug: slug } });
  }

  upsertUnitEconomics(slug: string, input: UnitEconomicsInput): Promise<PortfolioUnitEconomics> {
    const data = {
      asOf: input.asOf,
      cac: input.cac.toString(),
      ltv: input.ltv.toString(),
      paybackMonths: input.paybackMonths.toString(),
      arpu: input.arpu.toString(),
      grossMargin: input.grossMargin.toString(),
      nrr: input.nrr.toString(),
      churnMonthly: input.churnMonthly.toString(),
    };
    return this.writer.portfolioUnitEconomics.upsert({
      where: { businessSlug: slug },
      create: { businessSlug: slug, ...data },
      update: data,
    });
  }

  // ─── Cohorts ───────────────────────────────────────────────────────────

  listCohorts(slug: string): Promise<PortfolioCohort[]> {
    return this.reader.portfolioCohort.findMany({
      where: { businessSlug: slug },
      orderBy: { cohortMonth: 'asc' },
    });
  }

  async replaceCohorts(slug: string, cohorts: CohortInput[]): Promise<number> {
    return this.writer.$transaction(async (tx) => {
      await tx.portfolioCohort.deleteMany({ where: { businessSlug: slug } });
      if (cohorts.length === 0) return 0;
      await tx.portfolioCohort.createMany({
        data: cohorts.map((c) => ({
          id: uuidv7(),
          businessSlug: slug,
          cohortMonth: c.cohortMonth,
          customers: c.customers,
          m0: c.m0.toString(),
          m3: c.m3.toString(),
          m6: c.m6.toString(),
          m12: c.m12.toString(),
        })),
      });
      return cohorts.length;
    });
  }

  // ─── Headcount ─────────────────────────────────────────────────────────

  async getLatestHeadcount(slug: string): Promise<PortfolioHeadcount[]> {
    const latest = await this.reader.portfolioHeadcount.findFirst({
      where: { businessSlug: slug },
      orderBy: { asOf: 'desc' },
      select: { asOf: true },
    });
    if (!latest) return [];
    return this.reader.portfolioHeadcount.findMany({
      where: { businessSlug: slug, asOf: latest.asOf },
      orderBy: { ftes: 'desc' },
    });
  }

  async replaceHeadcount(slug: string, asOf: Date, rows: HeadcountInput[]): Promise<number> {
    return this.writer.$transaction(async (tx) => {
      await tx.portfolioHeadcount.deleteMany({ where: { businessSlug: slug, asOf } });
      if (rows.length === 0) return 0;
      await tx.portfolioHeadcount.createMany({
        data: rows.map((r) => ({
          id: uuidv7(),
          businessSlug: slug,
          asOf,
          function: r.function,
          ftes: r.ftes,
          payrollMonthly: r.payrollMonthly.toString(),
          openRoles: r.openRoles,
        })),
      });
      return rows.length;
    });
  }
}
