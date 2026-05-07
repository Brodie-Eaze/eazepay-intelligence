/**
 * Portfolio surface — verticals → businesses → financial deep-dive.
 *
 * Two halves: a READ surface (used by the UI) and an INGESTION surface
 * (used by devs and the eventual ETL workers to push real silo data).
 *
 * Security model:
 *   - Reads behind requireAuth.
 *   - Writes behind requireAuth + csrfGuard + requireRole('ADMIN'). When the
 *     PORTFOLIO_OPERATOR role lands, swap ADMIN for PORTFOLIO_OPERATOR.
 *   - Every financial deep-dive read writes a PORTFOLIO_FINANCIALS_ACCESSED
 *     audit row (CC7.3). Every ingestion call writes a PORTFOLIO_DATA_INGESTED
 *     row tagged with surface + counts.
 *   - No PII, but financials are RESTRICTED data. Don't echo payloads into
 *     request logs (Fastify redaction config covers this globally).
 *
 * Read precedence: pushed real data > deterministic mock generator. So the
 * moment a dev hits POST /pnl with real data, the UI surfaces it without any
 * code change. When the persistence layer lands, replace the in-memory store
 * in portfolio.fixtures.ts with Prisma calls — the route layer doesn't change.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import {
  listVerticals,
  getVertical,
  listBusinesses,
  getBusiness,
  buildMonthlyPnl,
  buildRevenueChannels,
  buildProductLines,
  buildUnitEconomics,
  buildCohorts,
  buildHeadcount,
  upsertVertical,
  upsertBusiness,
  patchBusiness,
  setPnl,
  getPushedPnl,
  setChannels,
  getPushedChannels,
  setProducts,
  getPushedProducts,
  setUnitEconomics,
  getPushedUnitEconomics,
  setCohorts,
  getPushedCohorts,
  setHeadcount,
  getPushedHeadcount,
} from './portfolio.fixtures.js';

const VerticalParam = z.object({ vertical: z.string().min(1).max(64) });
const BusinessParam = z.object({ slug: z.string().min(1).max(64) });

// ─── Ingestion schemas (the dev contract) ────────────────────────────────
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
  status: z.enum(['ACTIVE', 'INTEGRATING', 'EXITED', 'PROSPECT']),
  acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  ownershipPct: z.number().min(0).max(1),
  hqRegion: z.string().min(1).max(40),
  segment: z.string().min(1).max(120),
  fteCount: z.number().int().min(0),
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
        cohort: z.string().min(1).max(16),
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

export async function registerPortfolioRoutes(app: FastifyInstance): Promise<void> {
  // ─── READ: Portfolio index — verticals + roll-ups ───────────────────────
  app.get('/portfolio', { preHandler: requireAuth }, async () => {
    const verticals = listVerticals();
    const all = listBusinesses();
    return {
      verticals: verticals.map((v) => {
        const inV = all.filter((b) => b.vertical === v.slug);
        const ttmRevenue = inV.reduce((s, b) => s + b.ttmRevenue, 0);
        const ttmEbitda = inV.reduce((s, b) => s + b.ttmEbitda, 0);
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
        ttmRevenue: all.reduce((s, b) => s + b.ttmRevenue, 0),
        ttmEbitda: all.reduce((s, b) => s + b.ttmEbitda, 0),
        fteCount: all.reduce((s, b) => s + b.fteCount, 0),
        cashOnHand: all.reduce((s, b) => s + b.cashOnHand, 0),
        netDebt: all.reduce((s, b) => s + b.netDebt, 0),
      },
    };
  });

  // ─── READ: Vertical detail ──────────────────────────────────────────────
  app.get('/portfolio/verticals/:vertical', { preHandler: requireAuth }, async (req) => {
    const params = VerticalParam.parse(req.params);
    const vertical = getVertical(params.vertical);
    if (!vertical) throw errors.notFound('vertical');
    const businesses = listBusinesses({ vertical: vertical.slug as never });
    return {
      vertical,
      rollup: {
        businessCount: businesses.length,
        activeCount: businesses.filter((b) => b.status === 'ACTIVE').length,
        ttmRevenue: businesses.reduce((s, b) => s + b.ttmRevenue, 0),
        ttmEbitda: businesses.reduce((s, b) => s + b.ttmEbitda, 0),
        ttmGrossProfit: businesses.reduce((s, b) => s + b.ttmGrossProfit, 0),
        fteCount: businesses.reduce((s, b) => s + b.fteCount, 0),
        cashOnHand: businesses.reduce((s, b) => s + b.cashOnHand, 0),
        netDebt: businesses.reduce((s, b) => s + b.netDebt, 0),
      },
      businesses,
    };
  });

  // ─── READ: Business overview ────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    const vertical = getVertical(business.vertical);
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'overview', vertical: business.vertical },
    });
    return { business, vertical };
  });

  // ─── READ: Business P&L ─────────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/pnl', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    const periods = getPushedPnl(business.slug) ?? buildMonthlyPnl(business);
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: {
        surface: 'pnl',
        months: periods.length,
        source: getPushedPnl(business.slug) ? 'ingested' : 'generated',
      },
    });
    return { periods };
  });

  // ─── READ: Business revenue ─────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/revenue', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'revenue' },
    });
    return {
      channels: getPushedChannels(business.slug) ?? buildRevenueChannels(business),
      products: getPushedProducts(business.slug) ?? buildProductLines(business),
    };
  });

  // ─── READ: Unit economics ───────────────────────────────────────────────
  app.get(
    '/portfolio/businesses/:slug/unit-economics',
    { preHandler: requireAuth },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      const business = getBusiness(params.slug);
      if (!business) throw errors.notFound('business');
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_FINANCIALS_ACCESSED',
        resourceType: 'portfolio_business',
        resourceId: business.slug,
        metadata: { surface: 'unit_economics' },
      });
      return getPushedUnitEconomics(business.slug) ?? buildUnitEconomics(business);
    },
  );

  // ─── READ: Cohorts ──────────────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/cohorts', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'cohorts' },
    });
    return { cohorts: getPushedCohorts(business.slug) ?? buildCohorts(business) };
  });

  // ─── READ: Headcount ────────────────────────────────────────────────────
  app.get('/portfolio/businesses/:slug/headcount', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'headcount' },
    });
    return { rows: getPushedHeadcount(business.slug) ?? buildHeadcount(business) };
  });

  // ─── INGESTION: Vertical upsert ─────────────────────────────────────────
  app.post(
    '/portfolio/verticals',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const body = VerticalUpsert.parse(req.body);
      const created = upsertVertical(body as never);
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
      const body = BusinessUpsert.parse(req.body);
      if (!getVertical(body.vertical)) throw errors.notFound('vertical');
      const existed = Boolean(getBusiness(body.slug));
      const saved = upsertBusiness(body as never);
      await writeAuditLog({
        req,
        action: existed ? 'PORTFOLIO_BUSINESS_UPDATED' : 'PORTFOLIO_BUSINESS_CREATED',
        resourceType: 'portfolio_business',
        resourceId: saved.slug,
        metadata: { vertical: saved.vertical, status: saved.status },
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
      const updated = patchBusiness(params.slug, body as never);
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

  // ─── INGESTION: P&L bulk upsert ─────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/pnl',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      if (!getBusiness(params.slug)) throw errors.notFound('business');
      const body = PnlPush.parse(req.body);
      setPnl(params.slug, body.periods);
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'pnl', count: body.periods.length },
      });
      return { ingested: body.periods.length };
    },
  );

  // ─── INGESTION: Revenue (channels + products) ───────────────────────────
  app.post(
    '/portfolio/businesses/:slug/revenue',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      if (!getBusiness(params.slug)) throw errors.notFound('business');
      const body = RevenuePush.parse(req.body);
      setChannels(params.slug, body.channels);
      setProducts(params.slug, body.products);
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: {
          surface: 'revenue',
          channels: body.channels.length,
          products: body.products.length,
        },
      });
      return { channels: body.channels.length, products: body.products.length };
    },
  );

  // ─── INGESTION: Unit economics ──────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/unit-economics',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      if (!getBusiness(params.slug)) throw errors.notFound('business');
      const body = UnitEconomicsPush.parse(req.body);
      setUnitEconomics(params.slug, body);
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'unit_economics' },
      });
      return body;
    },
  );

  // ─── INGESTION: Cohorts ─────────────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/cohorts',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      if (!getBusiness(params.slug)) throw errors.notFound('business');
      const body = CohortsPush.parse(req.body);
      setCohorts(params.slug, body.cohorts);
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'cohorts', count: body.cohorts.length },
      });
      return { ingested: body.cohorts.length };
    },
  );

  // ─── INGESTION: Headcount ───────────────────────────────────────────────
  app.post(
    '/portfolio/businesses/:slug/headcount',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const params = BusinessParam.parse(req.params);
      if (!getBusiness(params.slug)) throw errors.notFound('business');
      const body = HeadcountPush.parse(req.body);
      setHeadcount(params.slug, body.rows);
      await writeAuditLog({
        req,
        action: 'PORTFOLIO_DATA_INGESTED',
        resourceType: 'portfolio_business',
        resourceId: params.slug,
        metadata: { surface: 'headcount', count: body.rows.length },
      });
      return { ingested: body.rows.length };
    },
  );
}
