/**
 * Portfolio surface — verticals → businesses → financial deep-dive.
 *
 * Two halves: a READ surface (used by the UI) and an INGESTION surface
 * (used by devs and the eventual ETL workers to push real silo data).
 *
 * v0 was fixture-backed in-memory; this is the durable Prisma-backed
 * implementation. Reads come from `portfolio_*` tables via
 * `PortfolioRepository`; writes upsert / replace-set on those tables.
 *
 * Security model:
 *   - Reads behind requireAuth.
 *   - Writes behind requireAuth + csrfGuard + requireRole('ADMIN').
 *     Swap ADMIN for PORTFOLIO_OPERATOR when that role lands.
 *   - Every financial deep-dive read writes a PORTFOLIO_FINANCIALS_ACCESSED
 *     audit row (CC7.3). Every ingestion call writes a PORTFOLIO_DATA_INGESTED
 *     row tagged with surface + counts.
 *   - Financials are RESTRICTED data — Fastify redaction config strips
 *     payloads from request logs.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PortfolioBusinessStatus } from '@prisma/client';
import { getPrismaWriter, getPrismaReader } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { PortfolioRepository } from './portfolio.repository.js';

const VerticalParam = z.object({ vertical: z.string().min(1).max(64) });
const BusinessParam = z.object({ slug: z.string().min(1).max(64) });

const VerticalUpsert = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'lowercase, digits, dashes only'),
  name: z.string().min(1).max(120),
  description: z.string().max(400).default(''),
});

const BusinessUpsert = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'lowercase, digits, dashes only'),
  name: z.string().min(1).max(160),
  vertical: z.string().min(1).max(64),
  status: z.nativeEnum(PortfolioBusinessStatus),
  acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  ownershipPct: z.number().min(0).max(1),
  hqRegion: z.string().min(1).max(40),
  segment: z.string().min(1).max(120),
  fteCount: z.number().int().min(0),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/)
    .optional(),
  ttmRevenue: z.number().min(0),
  ttmEbitda: z.number(),
  ttmGrossProfit: z.number(),
  arr: z.number().min(0).default(0),
  nrr: z.number().min(0).max(3),
  grossMargin: z.number().min(-1).max(1),
  cashOnHand: z.number(),
  netDebt: z.number(),
});

const BusinessPatch = BusinessUpsert.partial().omit({ slug: true });

const FinancialPeriod = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodLabel: z.string().min(1).max(16),
  revenue: z.number(),
  cogs: z.number(),
  grossProfit: z.number(),
  marketingSpend: z.number(),
  payroll: z.number(),
  rentAndUtilities: z.number(),
  softwareAndTools: z.number(),
  professionalServices: z.number(),
  otherOpex: z.number(),
  ebitda: z.number(),
  depreciation: z.number(),
  interest: z.number(),
  tax: z.number(),
  netIncome: z.number(),
  cashIn: z.number(),
  cashOut: z.number(),
  arBalance: z.number(),
  apBalance: z.number(),
});
const PnlPush = z.object({ periods: z.array(FinancialPeriod).min(1).max(120) });

const RevenuePush = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  channels: z
    .array(
      z.object({
        channel: z.string().min(1).max(80),
        revenue: z.number().min(0),
        customers: z.number().int().min(0),
        share: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(50),
  products: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        revenue: z.number().min(0),
        units: z.number().int().min(0),
        avgPrice: z.number().min(0),
      }),
    )
    .min(1)
    .max(50),
});

const UnitEconomicsPush = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cac: z.number().min(0),
  ltv: z.number().min(0),
  paybackMonths: z.number().min(0),
  arpu: z.number().min(0),
  grossMargin: z.number().min(-1).max(1),
  nrr: z.number().min(0).max(3),
  churnMonthly: z.number().min(0).max(1),
});

const CohortsPush = z.object({
  cohorts: z
    .array(
      z.object({
        cohortMonth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        customers: z.number().int().min(0),
        m0: z.number().min(0).max(1),
        m3: z.number().min(0).max(1),
        m6: z.number().min(0).max(1),
        m12: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(36),
});

const HeadcountPush = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  rows: z
    .array(
      z.object({
        function: z.string().min(1).max(80),
        ftes: z.number().int().min(0),
        payrollMonthly: z.number().min(0),
        openRoles: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(40),
});

function todayDate(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function registerPortfolioRoutes(app: FastifyInstance): Promise<void> {
  const repo = new PortfolioRepository(getPrismaWriter(), getPrismaReader());

  // ─── READ: Portfolio index — verticals + roll-ups ───────────────────────
  app.get('/portfolio', { preHandler: requireAuth }, async () => {
    const [verticals, all] = await Promise.all([repo.listVerticals(), repo.listBusinesses()]);
    return {
      verticals: verticals.map((v) => {
        const inV = all.filter((b) => b.verticalSlug === v.slug);
        const ttmRevenue = inV.reduce((s, b) => s + Number(b.ttmRevenue), 0);
        const ttmEbitda = inV.reduce((s, b) => s + Number(b.ttmEbitda), 0);
        const fteCount = inV.reduce((s, b) => s + b.fteCount, 0);
        return {
          slug: v.slug,
          name: v.name,
          description: v.description,
          businessCount: inV.length,
          activeCount: inV.filter((b) => b.status === 'ACTIVE').length,
          ttmRevenue,
          ttmEbitda,
          ebitdaMargin: ttmRevenue ? ttmEbitda / ttmRevenue : 0,
          fteCount,
        };
      }),
      rollup: {
        businessCount: all.length,
        activeCount: all.filter((b) => b.status === 'ACTIVE').length,
        ttmRevenue: all.reduce((s, b) => s + Number(b.ttmRevenue), 0),
        ttmEbitda: all.reduce((s, b) => s + Number(b.ttmEbitda), 0),
        fteCount: all.reduce((s, b) => s + b.fteCount, 0),
        cashOnHand: all.reduce((s, b) => s + Number(b.cashOnHand), 0),
        netDebt: all.reduce((s, b) => s + Number(b.netDebt), 0),
      },
    };
  });

  // ─── READ: Vertical detail ──────────────────────────────────────────────
  app.get('/portfolio/verticals/:vertical', { preHandler: requireAuth }, async (req) => {
    const params = VerticalParam.parse(req.params);
    const vertical = await repo.getVertical(params.vertical);
    if (!vertical) throw errors.notFound('vertical');
    const businesses = await repo.listBusinesses({ vertical: vertical.slug });
    return {
      vertical,
      rollup: {
        businessCount: businesses.length,
        activeCount: businesses.filter((b) => b.status === 'ACTIVE').length,
        ttmRevenue: businesses.reduce((s, b) => s + Number(b.ttmRevenue), 0),
        ttmEbitda: businesses.reduce((s, b) => s + Number(b.ttmEbitda), 0),
        ttmGrossProfit: businesses.reduce((s, b) => s + Number(b.ttmGrossProfit), 0),
        fteCount: businesses.reduce((s, b) => s + b.fteCount, 0),
        cashOnHand: businesses.reduce((s, b) => s + Number(b.cashOnHand), 0),
        netDebt: businesses.reduce((s, b) => s + Number(b.netDebt), 0),
      },
      businesses,
    };
  });

  // ─── READ: Business overview ────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = await repo.getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    const vertical = await repo.getVertical(business.verticalSlug);
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'overview', vertical: business.verticalSlug },
    });
    return { business, vertical };
  });

  // ─── READ: Business P&L ─────────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/pnl', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = await repo.getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    const periods = await repo.listFinancialPeriods(business.slug);
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'pnl', months: periods.length },
    });
    return { periods };
  });

  // ─── READ: Business revenue ─────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/revenue', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = await repo.getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    const [channels, products] = await Promise.all([
      repo.getLatestChannels(business.slug),
      repo.getLatestProducts(business.slug),
    ]);
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'revenue' },
    });
    return { channels, products };
  });

  // ─── READ: Unit economics ───────────────────────────────────────────────
  app.get(
    '/portfolio/businesses/:slug/unit-economics',
    { preHandler: requireAuth },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      const business = await repo.getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_FINANCIALS_ACCESSED',
        resourceType: 'portfolio_business',
        resourceId: business.slug,
        metadata: { surface: 'unit_economics' },
      });
      return repo.getUnitEconomics(business.slug);
    },
  );

  // ─── READ: Cohorts ──────────────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/cohorts', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = await repo.getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'cohorts' },
    });
    return { cohorts: await repo.listCohorts(business.slug) };
  });

  // ─── READ: Headcount ────────────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/headcount', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = await repo.getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'headcount' },
    });
    return { rows: await repo.getLatestHeadcount(business.slug) };
  });

  // ─── INGESTION: Vertical upsert ─────────────────────────────────────────
  app.post(
    '/portfolio/verticals',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const body = VerticalUpsert.parse(req.body);
      const orgId = auth.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      const created = await repo.upsertVertical({
        orgId,
        slug: body.slug,
        name: body.name,
        description: body.description,
      });
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_VERTICAL_CREATED',
        resourceType: 'portfolio_vertical',
        resourceId: created.slug,
        metadata: { name: created.name },
      });
      return created;
    },
  );

  // ─── INGESTION: Business upsert (full record) ───────────────────────────
  app.post(
    '/portfolio/businesses',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const body = BusinessUpsert.parse(req.body);
      if (!(await repo.getVertical(body.vertical))) throw errors.notFound('vertical');
      const existed = Boolean(await repo.getBusiness(body.slug));
      const orgId = auth.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      const saved = await repo.upsertBusiness({
        orgId,
        slug: body.slug,
        name: body.name,
        verticalSlug: body.vertical,
        status: body.status,
        acquiredAt: new Date(body.acquiredAt),
        ownershipPct: body.ownershipPct,
        hqRegion: body.hqRegion,
        segment: body.segment,
        fteCount: body.fteCount,
        ...(body.currency ? { currency: body.currency } : {}),
        ttmRevenue: body.ttmRevenue,
        ttmEbitda: body.ttmEbitda,
        ttmGrossProfit: body.ttmGrossProfit,
        arr: body.arr,
        nrr: body.nrr,
        grossMargin: body.grossMargin,
        cashOnHand: body.cashOnHand,
        netDebt: body.netDebt,
      });
      await writeAuditLog({
        req,
        action: existed ? 'PORTFOLIO_BUSINESS_UPDATED' : 'PORTFOLIO_BUSINESS_CREATED',
        resourceType: 'portfolio_business',
        resourceId: saved.slug,
        metadata: { vertical: saved.verticalSlug, status: saved.status },
      });
      return saved;
    },
  );

  // ─── INGESTION: Business patch (partial profile update) ─────────────────
  app.patch(
    '/portfolio/businesses/:slug',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      const body = BusinessPatch.parse(req.body);
      const { vertical: _v, acquiredAt: _a, ...rest } = body;
      const updated = await repo.patchBusiness(params.slug, {
        ...rest,
        ...(_a ? { acquiredAt: new Date(_a) } : {}),
        ...(_v ? { verticalSlug: _v } : {}),
      });
      if (!updated) throw errors.notFound('business');
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_BUSINESS_UPDATED',
        resourceType: 'portfolio_business',
        resourceId: updated.slug,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    },
  );

  // ─── INGESTION: P&L bulk replace ────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/pnl',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const params = BusinessParam.parse(req.params);
      const business = await repo.getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      const body = PnlPush.parse(req.body);
      const orgId = auth.orgId ?? business.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      const ingested = await repo.replaceFinancialPeriods(
        params.slug,
        orgId,
        body.periods.map((p) => ({ ...p, periodStart: new Date(p.periodStart) })),
      );
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'pnl', count: ingested },
      });
      return { ingested };
    },
  );

  // ─── INGESTION: Revenue (channels + products) ───────────────────────────
  app.post(
    '/portfolio/businesses/:slug/revenue',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const params = BusinessParam.parse(req.params);
      const business = await repo.getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      const body = RevenuePush.parse(req.body);
      const asOf = body.asOf ? new Date(body.asOf) : todayDate();
      const orgId = auth.orgId ?? business.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      // Atomic replace of both surfaces in one transaction — channels and
      // products are a logical unit; partial failure must roll back to the
      // previous snapshot rather than landing one half of the new state.
      const { channels, products } = await repo.replaceRevenue(
        params.slug,
        orgId,
        asOf,
        body.channels,
        body.products,
      );
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'revenue', channels, products, asOf: asOf.toISOString().slice(0, 10) },
      });
      return { channels, products };
    },
  );

  // ─── INGESTION: Unit economics ──────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/unit-economics',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const params = BusinessParam.parse(req.params);
      const business = await repo.getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      const body = UnitEconomicsPush.parse(req.body);
      const orgId = auth.orgId ?? business.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      const saved = await repo.upsertUnitEconomics(params.slug, orgId, {
        asOf: body.asOf ? new Date(body.asOf) : todayDate(),
        cac: body.cac,
        ltv: body.ltv,
        paybackMonths: body.paybackMonths,
        arpu: body.arpu,
        grossMargin: body.grossMargin,
        nrr: body.nrr,
        churnMonthly: body.churnMonthly,
      });
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'unit_economics' },
      });
      return saved;
    },
  );

  // ─── INGESTION: Cohorts ─────────────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/cohorts',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const params = BusinessParam.parse(req.params);
      const business = await repo.getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      const body = CohortsPush.parse(req.body);
      const orgId = auth.orgId ?? business.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      const ingested = await repo.replaceCohorts(
        params.slug,
        orgId,
        body.cohorts.map((c) => ({ ...c, cohortMonth: new Date(c.cohortMonth) })),
      );
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'cohorts', count: ingested },
      });
      return { ingested };
    },
  );

  // ─── INGESTION: Headcount ───────────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/headcount',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const auth = req.auth!;
      const params = BusinessParam.parse(req.params);
      const business = await repo.getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      const body = HeadcountPush.parse(req.body);
      const asOf = body.asOf ? new Date(body.asOf) : todayDate();
      const orgId = auth.orgId ?? business.orgId ?? (await getBootstrapOrgId(getPrismaWriter()));
      const ingested = await repo.replaceHeadcount(params.slug, orgId, asOf, body.rows);
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'headcount', count: ingested, asOf: asOf.toISOString().slice(0, 10) },
      });
      return { ingested };
    },
  );
}
