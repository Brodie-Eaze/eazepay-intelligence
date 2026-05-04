import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { decryptPII } from '../../shared/utils/encryption.js';
import { errors } from '../../shared/errors/app-error.js';

/**
 * Customer-centric views. A "customer" is identified by the deterministic hash
 * of their email — applications get matched across partners and time so we can
 * see one financial profile per real person, not one per application.
 *
 * Hash is hex-encoded for URL-safety.
 */

const ListQuery = z.object({
  q: z.string().optional(),
  riskBand: z.enum(['PRIME', 'NEAR_PRIME', 'SUBPRIME', 'DEEP_SUBPRIME', 'UNSCORED']).optional(),
  partnerId: z.string().uuid().optional(),
  hasFunded: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface CustomerRow {
  emailHash: string;
  applications: number;
  partnerCount: number;
  fundings: number;
  latestApplicationAt: string;
  latestPartnerId: string;
  latestStatus: string;
  latestCreditScore: number | null;
  latestIncome: string | null;
  latestPropensity: string | null;
  totalFunded: string;
  riskBand: string;
}

function riskBandFor(score: number | null | undefined): string {
  if (score == null) return 'UNSCORED';
  if (score >= 720) return 'PRIME';
  if (score >= 660) return 'NEAR_PRIME';
  if (score >= 580) return 'SUBPRIME';
  return 'DEEP_SUBPRIME';
}

export async function registerCustomerRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  // ─── Customer book ───────────────────────────────────────────────────────
  app.get('/customers', { preHandler: requireAuth }, async (req) => {
    const q = ListQuery.parse(req.query);
    const conds: Prisma.Sql[] = [];
    if (q.partnerId) conds.push(Prisma.sql`a.partner_id = ${q.partnerId}::uuid`);
    if (q.hasFunded === 'true') conds.push(Prisma.sql`EXISTS (SELECT 1 FROM lender_decisions ld WHERE ld.application_id = a.id AND ld.funding_status = 'FUNDED')`);
    if (q.hasFunded === 'false') conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM lender_decisions ld WHERE ld.application_id = a.id AND ld.funding_status = 'FUNDED')`);

    const where = conds.length === 0 ? Prisma.sql`` : Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`;

    const rows = await prisma.$queryRaw<Array<{
      email_hash: Buffer;
      applications: bigint;
      partner_count: bigint;
      fundings: bigint;
      latest_app_at: Date;
      latest_partner_id: string;
      latest_status: string;
      latest_credit: number | null;
      latest_income: string | null;
      latest_propensity: string | null;
      total_funded: string;
    }>>(Prisma.sql`
      WITH apps AS (
        SELECT a.consumer_email_hash AS email_hash,
               a.id AS application_id,
               a.partner_id,
               a.status::text AS status,
               a.credit_score,
               a.noted_annual_income,
               a.propensity_score,
               a.created_at
        FROM applications a
        ${where}
      ),
      latest AS (
        SELECT DISTINCT ON (email_hash)
               email_hash, application_id, partner_id, status, credit_score, noted_annual_income, propensity_score, created_at
        FROM apps
        ORDER BY email_hash, created_at DESC
      ),
      funded AS (
        SELECT a.consumer_email_hash AS email_hash,
               COUNT(DISTINCT ld.id) AS fundings,
               COALESCE(SUM(ld.funding_amount), 0) AS total_funded
        FROM applications a
        JOIN lender_decisions ld ON ld.application_id = a.id
        WHERE ld.funding_status = 'FUNDED'
        GROUP BY a.consumer_email_hash
      )
      SELECT apps.email_hash,
             COUNT(DISTINCT apps.application_id)::bigint AS applications,
             COUNT(DISTINCT apps.partner_id)::bigint AS partner_count,
             COALESCE(funded.fundings, 0)::bigint AS fundings,
             latest.created_at AS latest_app_at,
             latest.partner_id AS latest_partner_id,
             latest.status AS latest_status,
             latest.credit_score AS latest_credit,
             latest.noted_annual_income::text AS latest_income,
             latest.propensity_score::text AS latest_propensity,
             COALESCE(funded.total_funded, 0)::text AS total_funded
      FROM apps
      JOIN latest ON latest.email_hash = apps.email_hash
      LEFT JOIN funded ON funded.email_hash = apps.email_hash
      GROUP BY apps.email_hash, latest.created_at, latest.partner_id, latest.status,
               latest.credit_score, latest.noted_annual_income, latest.propensity_score,
               funded.fundings, funded.total_funded
      ORDER BY latest.created_at DESC
      LIMIT ${q.limit}
    `);

    let mapped: CustomerRow[] = rows.map((r) => ({
      emailHash: Buffer.from(r.email_hash).toString('hex'),
      applications: Number(r.applications),
      partnerCount: Number(r.partner_count),
      fundings: Number(r.fundings),
      latestApplicationAt: r.latest_app_at.toISOString(),
      latestPartnerId: r.latest_partner_id,
      latestStatus: r.latest_status,
      latestCreditScore: r.latest_credit,
      latestIncome: r.latest_income,
      latestPropensity: r.latest_propensity,
      totalFunded: r.total_funded,
      riskBand: riskBandFor(r.latest_credit),
    }));

    if (q.riskBand) mapped = mapped.filter((c) => c.riskBand === q.riskBand);
    return mapped;
  });

  // ─── Customer detail ─────────────────────────────────────────────────────
  app.get('/customers/:hash', { preHandler: requireAuth }, async (req) => {
    const params = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    const hashBuf = Buffer.from(params.hash, 'hex');

    const apps = await prisma.application.findMany({
      where: { consumerEmailHash: hashBuf },
      orderBy: { createdAt: 'desc' },
      include: {
        partner: { select: { id: true, name: true, externalId: true, industry: true } },
        lenderDecisions: { orderBy: { decisionTimestamp: 'asc' } },
      },
    });
    if (apps.length === 0) throw errors.notFound('Customer', params.hash);

    const decisionIds = apps.flatMap((a) => a.lenderDecisions.map((d) => d.id));
    const revenueEvents = decisionIds.length === 0 ? [] : await prisma.revenueEvent.findMany({
      where: { lenderDecisionId: { in: decisionIds } },
      orderBy: { effectiveAt: 'asc' },
    });

    // Aggregate the financial picture
    const latest = apps[0]!;
    const allCreditScores = apps.map((a) => a.creditScore).filter((s): s is number => s != null);
    const totalFunded = apps.flatMap((a) => a.lenderDecisions)
      .filter((d) => d.fundingStatus === 'FUNDED' && d.fundingAmount)
      .reduce((s, d) => s + Number(d.fundingAmount!.toString()), 0);
    const totalRevenue = revenueEvents.reduce((s, r) => s + Number(r.amount.toString()), 0);
    const partners = Array.from(new Set(apps.map((a) => a.partner.id)));

    return {
      emailHash: params.hash,
      profile: {
        firstSeen: apps[apps.length - 1]!.createdAt.toISOString(),
        lastSeen: latest.createdAt.toISOString(),
        applications: apps.length,
        partners: partners.length,
        riskBand: riskBandFor(latest.creditScore),
        latestCreditScore: latest.creditScore,
        avgCreditScore: allCreditScores.length ? Math.round(allCreditScores.reduce((s, n) => s + n, 0) / allCreditScores.length) : null,
        creditScoreTrend: apps.map((a) => ({ at: a.createdAt.toISOString(), score: a.creditScore })).reverse(),
        latestIncome: latest.notedAnnualIncome?.toString() ?? null,
        latestPropensity: latest.propensityScore?.toString() ?? null,
        latestAvailableCredit: latest.availableCredit?.toString() ?? null,
        latestOpenLines: latest.openLinesOfCredit,
        bankStatementsProvided: apps.some((a) => a.bankStatementsProvided),
        merchantPreapprovals: apps.filter((a) => a.merchantPreapproval).length,
        consumerPreapprovals: apps.filter((a) => a.consumerPreapproval).length,
      },
      financial: {
        totalFunded: totalFunded.toFixed(2),
        totalRevenue: totalRevenue.toFixed(2),
        totalFundingEstimate: apps.reduce((s, a) => s + Number(a.fundingEstimate?.toString() ?? '0'), 0).toFixed(2),
      },
      applications: apps.map((a) => ({
        id: a.id,
        externalApplicationId: a.externalApplicationId,
        createdAt: a.createdAt.toISOString(),
        status: a.status,
        partner: a.partner,
        creditScore: a.creditScore,
        availableCredit: a.availableCredit?.toString() ?? null,
        notedAnnualIncome: a.notedAnnualIncome?.toString() ?? null,
        bankStatementsProvided: a.bankStatementsProvided,
        merchantPreapproval: a.merchantPreapproval,
        merchantPreapprovalAmount: a.merchantPreapprovalAmount?.toString() ?? null,
        consumerPreapproval: a.consumerPreapproval,
        consumerPreapprovalAmount: a.consumerPreapprovalAmount?.toString() ?? null,
        fundingEstimate: a.fundingEstimate?.toString() ?? null,
        propensityScore: a.propensityScore?.toString() ?? null,
        openLinesOfCredit: a.openLinesOfCredit,
        decisions: a.lenderDecisions.map((d) => ({
          id: d.id,
          lenderName: d.lenderName,
          lenderTier: d.lenderTier,
          decision: d.decision,
          decisionTimestamp: d.decisionTimestamp.toISOString(),
          approvalAmount: d.approvalAmount?.toString() ?? null,
          apr: d.apr?.toString() ?? null,
          term: d.term,
          fundingStatus: d.fundingStatus,
          fundingAmount: d.fundingAmount?.toString() ?? null,
        })),
      })),
      revenueEvents: revenueEvents.map((r) => ({
        idempotencyKey: r.idempotencyKey,
        stream: r.stream,
        eventType: r.eventType,
        amount: r.amount.toString(),
        effectiveAt: r.effectiveAt.toISOString(),
      })),
    };
  });

  // ─── PII reveal for a customer (across their applications) ───────────────
  app.get('/customers/:hash/pii', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    if (auth.role !== 'ADMIN' && auth.role !== 'OPERATOR') {
      throw errors.forbidden('PII reveal requires ADMIN or OPERATOR role');
    }
    const params = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    const hashBuf = Buffer.from(params.hash, 'hex');
    const app = await prisma.application.findFirst({
      where: { consumerEmailHash: hashBuf },
      orderBy: { createdAt: 'desc' },
    });
    if (!app) throw errors.notFound('Customer', params.hash);
    const name = decryptPII(app.consumerNameCiphertext);
    const email = decryptPII(app.consumerEmailCiphertext);
    const phone = decryptPII(app.consumerPhoneCiphertext);
    await writeAuditLog({
      req,
      action: 'PII_ACCESSED',
      resourceType: 'customer',
      resourceId: params.hash,
      metadata: { fields: ['name', 'email', 'phone'] },
    });
    return { emailHash: params.hash, consumerName: name, consumerEmail: email, consumerPhone: phone };
  });

  // ─── Risk distribution ───────────────────────────────────────────────────
  app.get('/analytics/risk-distribution', { preHandler: requireAuth }, async () => {
    const buckets = await prisma.$queryRaw<Array<{ bucket: number; n: bigint; avg_income: string | null; avg_propensity: string | null }>>(Prisma.sql`
      SELECT CASE
               WHEN credit_score IS NULL THEN -1
               WHEN credit_score < 580 THEN 0
               WHEN credit_score < 660 THEN 580
               WHEN credit_score < 720 THEN 660
               WHEN credit_score < 800 THEN 720
               ELSE 800
             END AS bucket,
             COUNT(*)::bigint AS n,
             AVG(noted_annual_income)::text AS avg_income,
             AVG(propensity_score)::text AS avg_propensity
      FROM applications
      GROUP BY bucket
      ORDER BY bucket
    `);
    return buckets.map((b) => {
      const bucket = Number(b.bucket);
      const label = bucket === -1 ? 'Unscored'
        : bucket === 0 ? '< 580'
        : bucket === 580 ? '580–659'
        : bucket === 660 ? '660–719'
        : bucket === 720 ? '720–799'
        : '800+';
      const band = bucket === -1 ? 'UNSCORED'
        : bucket === 0 ? 'DEEP_SUBPRIME'
        : bucket === 580 ? 'SUBPRIME'
        : bucket === 660 ? 'NEAR_PRIME'
        : 'PRIME';
      return {
        bucket,
        label,
        riskBand: band,
        count: Number(b.n),
        avgIncome: b.avg_income,
        avgPropensity: b.avg_propensity,
      };
    });
  });

  // ─── Income / affordability distribution ─────────────────────────────────
  app.get('/analytics/income-distribution', { preHandler: requireAuth }, async () => {
    const buckets = await prisma.$queryRaw<Array<{ bucket: number; n: bigint; avg_credit: number | null; avg_funded: string | null }>>(Prisma.sql`
      SELECT CASE
               WHEN noted_annual_income IS NULL THEN -1
               WHEN noted_annual_income < 50000 THEN 0
               WHEN noted_annual_income < 80000 THEN 50000
               WHEN noted_annual_income < 120000 THEN 80000
               WHEN noted_annual_income < 200000 THEN 120000
               ELSE 200000
             END AS bucket,
             COUNT(*)::bigint AS n,
             AVG(credit_score) AS avg_credit,
             AVG(funding_estimate)::text AS avg_funded
      FROM applications
      GROUP BY bucket
      ORDER BY bucket
    `);
    return buckets.map((b) => {
      const bucket = Number(b.bucket);
      const label = bucket === -1 ? 'Not provided'
        : bucket === 0 ? '< $50k'
        : bucket === 50000 ? '$50–80k'
        : bucket === 80000 ? '$80–120k'
        : bucket === 120000 ? '$120–200k'
        : '$200k+';
      return {
        bucket,
        label,
        count: Number(b.n),
        avgCreditScore: b.avg_credit ? Math.round(Number(b.avg_credit)) : null,
        avgFundingEstimate: b.avg_funded,
      };
    });
  });

  // ─── Propensity calibration ──────────────────────────────────────────────
  // How well does HighSale's propensity score predict actual approval / funding?
  app.get('/analytics/propensity-calibration', { preHandler: requireAuth }, async () => {
    const rows = await prisma.$queryRaw<Array<{ bucket: number; n: bigint; approved: bigint; funded: bigint }>>(Prisma.sql`
      SELECT FLOOR(propensity_score * 10)::int AS bucket,
             COUNT(*)::bigint AS n,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lender_decisions ld WHERE ld.application_id = applications.id AND ld.decision='APPROVED'))::bigint AS approved,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lender_decisions ld WHERE ld.application_id = applications.id AND ld.funding_status='FUNDED'))::bigint AS funded
      FROM applications
      WHERE propensity_score IS NOT NULL
      GROUP BY bucket
      ORDER BY bucket
    `);
    return rows.map((r) => ({
      bucketLow: r.bucket / 10,
      bucketHigh: (r.bucket + 1) / 10,
      label: `${(r.bucket * 10).toFixed(0)}–${((r.bucket + 1) * 10).toFixed(0)}%`,
      count: Number(r.n),
      approvalRate: Number(r.n) ? Number(r.approved) / Number(r.n) : 0,
      fundingRate: Number(r.n) ? Number(r.funded) / Number(r.n) : 0,
    }));
  });
}
