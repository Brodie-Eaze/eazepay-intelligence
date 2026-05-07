/**
 * Portfolio surface — verticals → businesses → financial deep-dive.
 *
 * Security model:
 *   - Every endpoint behind requireAuth.
 *   - Financial deep-dive endpoints write a PORTFOLIO_FINANCIALS_ACCESSED
 *     audit row on every read. This is the source-of-truth log for who
 *     looked at which silo's P&L when — required for SOC 2 CC7.3 and any
 *     downstream pen-test attestation.
 *   - Currently all authenticated users can view the portfolio. When the
 *     PORTFOLIO_VIEWER role lands, gate the deep-dive endpoints behind
 *     `requireRole('PORTFOLIO_VIEWER')` — see TODO inline.
 *   - No PII, but financials are RESTRICTED data. Do not echo payloads
 *     into request logs (Fastify's redaction config covers this globally).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
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
} from './portfolio.fixtures.js';

const VerticalParam = z.object({ vertical: z.string().min(1).max(64) });
const BusinessParam = z.object({ slug: z.string().min(1).max(64) });

export async function registerPortfolioRoutes(app: FastifyInstance): Promise<void> {
  // ─── Portfolio index: verticals + roll-ups ──────────────────────────────
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

  // ─── Vertical detail: businesses in this vertical ───────────────────────
  app.get('/portfolio/verticals/:vertical', { preHandler: requireAuth }, async (req) => {
    const params = VerticalParam.parse(req.params);
    const vertical = getVertical(params.vertical);
    if (!vertical) throw errors.notFound('vertical');
    const businesses = listBusinesses({ vertical: vertical.slug });
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

  // ─── Business overview: snapshot card ───────────────────────────────────
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

  // ─── Business P&L (monthly periods) ─────────────────────────────────────
  app.get('/portfolio/businesses/:slug/pnl', { preHandler: requireAuth }, async (req) => {
    const params = BusinessParam.parse(req.params);
    const business = getBusiness(params.slug);
    if (!business) throw errors.notFound('business');
    const periods = buildMonthlyPnl(business);
    await writeAuditLog({
      req,
      action: 'PORTFOLIO_FINANCIALS_ACCESSED',
      resourceType: 'portfolio_business',
      resourceId: business.slug,
      metadata: { surface: 'pnl', months: periods.length },
    });
    return { periods };
  });

  // ─── Business revenue breakdown: channels + product lines ───────────────
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
      channels: buildRevenueChannels(business),
      products: buildProductLines(business),
    };
  });

  // ─── Business unit economics ────────────────────────────────────────────
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
      return buildUnitEconomics(business);
    },
  );

  // ─── Business cohorts (retention triangle) ──────────────────────────────
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
    return { cohorts: buildCohorts(business) };
  });

  // ─── Business headcount (function breakdown) ────────────────────────────
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
    return { rows: buildHeadcount(business) };
  });
}
