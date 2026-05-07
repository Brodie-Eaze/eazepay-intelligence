import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getPrismaReader } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { denyInvestorScope, requireRole } from '../../shared/middleware/rbac.middleware.js';

const ListWebhookQuery = z.object({
  source: z.enum(['BUZZPAY', 'PIXIE', 'MICAMP']).optional(),
  status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'REPLAYED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ListAuditQuery = z.object({
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Admin endpoints — operational visibility into the platform internals.
 * All locked behind ADMIN role + denyInvestorScope.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrismaReader();
  const redis = getRedis();

  // ─── Webhook events ──────────────────────────────────────────────────────
  app.get(
    '/admin/webhook-events',
    { preHandler: [requireAuth, denyInvestorScope, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const q = ListWebhookQuery.parse(req.query);
      const where: Prisma.WebhookEventWhereInput = {};
      if (q.source) where.source = q.source;
      if (q.status) where.status = q.status;
      const rows = await prisma.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: q.limit,
      });
      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        eventType: r.eventType,
        idempotencyKey: r.idempotencyKey,
        signatureValid: r.signatureValid,
        status: r.status,
        processingError: r.processingError,
        receivedAt: r.receivedAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
        latencyMs: r.processedAt ? r.processedAt.getTime() - r.receivedAt.getTime() : null,
      }));
    },
  );

  app.get(
    '/admin/webhook-events/health',
    { preHandler: [requireAuth, denyInvestorScope] },
    async () => {
      const since = new Date(Date.now() - 24 * 60 * 60_000);
      const counts = await prisma.webhookEvent.groupBy({
        by: ['source', 'status'],
        where: { receivedAt: { gte: since } },
        _count: { _all: true },
      });
      const lastReceived = await prisma.webhookEvent.groupBy({
        by: ['source'],
        _max: { receivedAt: true },
      });
      return {
        windowHours: 24,
        bySource: ['BUZZPAY', 'PIXIE', 'MICAMP'].map((src) => {
          const buckets = counts.filter((c) => c.source === src);
          const total = buckets.reduce((s, b) => s + b._count._all, 0);
          const failed = buckets.find((b) => b.status === 'FAILED')?._count._all ?? 0;
          const processed = buckets.find((b) => b.status === 'PROCESSED')?._count._all ?? 0;
          const received = buckets.find((b) => b.status === 'RECEIVED')?._count._all ?? 0;
          return {
            source: src,
            total,
            processed,
            failed,
            backlog: received,
            successRate: total ? processed / total : 0,
            lastReceivedAt:
              lastReceived.find((l) => l.source === src)?._max.receivedAt?.toISOString() ?? null,
          };
        }),
      };
    },
  );

  // ─── Audit logs ──────────────────────────────────────────────────────────
  app.get(
    '/audit-logs',
    { preHandler: [requireAuth, denyInvestorScope, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const q = ListAuditQuery.parse(req.query);
      const where: Prisma.AuditLogWhereInput = {};
      if (q.userId) where.userId = q.userId;
      if (q.action) where.action = q.action;
      if (q.resourceType) where.resourceType = q.resourceType;
      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        include: { user: { select: { email: true, role: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.user?.email ?? null,
        userRole: r.user?.role ?? null,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  // ─── System health (operational telemetry) ───────────────────────────────
  app.get('/admin/health', { preHandler: [requireAuth, denyInvestorScope] }, async () => {
    const dbStart = Date.now();
    const dbCounts = await prisma.$queryRaw<Array<{ relname: string; count: bigint }>>(Prisma.sql`
        SELECT relname, n_live_tup AS count
        FROM pg_stat_user_tables
        WHERE relname IN ('partners','applications','lender_decisions','revenue_events','webhook_events','pixie_metrics','users','audit_logs','refresh_tokens')
        ORDER BY relname
      `);
    const dbLatency = Date.now() - dbStart;

    const redisStart = Date.now();
    const queueDepth = {
      webhook: Number(await redis.llen('bull:eazepay.webhook:wait').catch(() => 0)),
      webhookActive: Number(await redis.llen('bull:eazepay.webhook:active').catch(() => 0)),
      webhookFailed: Number(await redis.llen('bull:eazepay.webhook:failed').catch(() => 0)),
      aggregation: Number(await redis.llen('bull:eazepay.aggregation:wait').catch(() => 0)),
    };
    const redisLatency = Date.now() - redisStart;

    const recentLogins = await prisma.auditLog.count({
      where: { action: 'USER_LOGIN', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    });
    const failedLogins = await prisma.auditLog.count({
      where: {
        action: 'USER_LOGIN_FAILED',
        createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      },
    });
    const piiAccess24h = await prisma.auditLog.count({
      where: { action: 'PII_ACCESSED', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    });

    const activeSessions = await prisma.refreshToken.count({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
    });

    return {
      generatedAt: new Date().toISOString(),
      database: {
        status: 'ok',
        latencyMs: dbLatency,
        rowCounts: dbCounts.map((r) => ({ table: r.relname, rows: Number(r.count) })),
      },
      redis: { status: 'ok', latencyMs: redisLatency, queueDepth },
      sessions: {
        active: activeSessions,
        recentLogins24h: recentLogins,
        failedLogins24h: failedLogins,
      },
      privacy: { piiAccess24h },
    };
  });

  // ─── Sessions (active refresh tokens) ────────────────────────────────────
  app.get(
    '/admin/sessions',
    { preHandler: [requireAuth, denyInvestorScope, requireRole('ADMIN')] },
    async () => {
      const rows = await prisma.refreshToken.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: { select: { email: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        userEmail: r.user.email,
        userRole: r.user.role,
        familyId: r.familyId,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }));
    },
  );

  // ─── Application timeline (full per-app view) ────────────────────────────
  app.get(
    '/applications/:id/timeline',
    { preHandler: [requireAuth, denyInvestorScope] },
    async (req) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const app = await prisma.application.findUnique({
        where: { id: params.id },
        include: {
          partner: { select: { id: true, name: true, tier: true, externalId: true } },
          lenderDecisions: { orderBy: { decisionTimestamp: 'asc' } },
        },
      });
      if (!app) return { error: 'not_found' };

      const revenue = await prisma.revenueEvent.findMany({
        where: { lenderDecisionId: { in: app.lenderDecisions.map((d) => d.id) } },
        orderBy: { effectiveAt: 'asc' },
      });

      return {
        application: {
          id: app.id,
          externalApplicationId: app.externalApplicationId,
          status: app.status,
          submittedAt: app.submittedAt?.toISOString() ?? null,
          createdAt: app.createdAt.toISOString(),
          updatedAt: app.updatedAt.toISOString(),
          enrichment: {
            creditScore: app.creditScore,
            availableCredit: app.availableCredit?.toString() ?? null,
            notedAnnualIncome: app.notedAnnualIncome?.toString() ?? null,
            bankStatementsProvided: app.bankStatementsProvided,
            merchantPreapproval: app.merchantPreapproval,
            merchantPreapprovalAmount: app.merchantPreapprovalAmount?.toString() ?? null,
            consumerPreapproval: app.consumerPreapproval,
            consumerPreapprovalAmount: app.consumerPreapprovalAmount?.toString() ?? null,
            fundingEstimate: app.fundingEstimate?.toString() ?? null,
            propensityScore: app.propensityScore?.toString() ?? null,
            openLinesOfCredit: app.openLinesOfCredit,
          },
        },
        partner: app.partner,
        decisions: app.lenderDecisions.map((d) => ({
          id: d.id,
          lenderName: d.lenderName,
          lenderTier: d.lenderTier,
          decision: d.decision,
          decisionTimestamp: d.decisionTimestamp.toISOString(),
          approvalAmount: d.approvalAmount?.toString() ?? null,
          apr: d.apr?.toString() ?? null,
          term: d.term,
          monthlyPayment: d.monthlyPayment?.toString() ?? null,
          originationFee: d.originationFee?.toString() ?? null,
          fundingStatus: d.fundingStatus,
          fundingTimestamp: d.fundingTimestamp?.toISOString() ?? null,
          fundingAmount: d.fundingAmount?.toString() ?? null,
        })),
        revenueEvents: revenue.map((r) => ({
          idempotencyKey: r.idempotencyKey,
          stream: r.stream,
          eventType: r.eventType,
          amount: r.amount.toString(),
          effectiveAt: r.effectiveAt.toISOString(),
        })),
      };
    },
  );

  // ─── Reconciliation: ledger SUM vs aggregation rollup ────────────────────
  app.get('/admin/reconciliation', { preHandler: [requireAuth, denyInvestorScope] }, async () => {
    const ledger = await prisma.$queryRaw<Array<{ month: Date; total: string }>>(Prisma.sql`
        SELECT date_trunc('month', effective_at) AS month,
               COALESCE(SUM(amount), 0)::text   AS total
        FROM revenue_events
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12
      `);
    const rollup = await prisma.$queryRaw<Array<{ month: Date; total: string }>>(Prisma.sql`
        SELECT date_trunc('month', period_start) AS month,
               COALESCE(SUM(total_revenue), 0)::text AS total
        FROM revenue_aggregations
        WHERE period = 'MONTHLY'
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12
      `);
    const ledgerMap = new Map(ledger.map((r) => [r.month.toISOString(), r.total]));
    const rollupMap = new Map(rollup.map((r) => [r.month.toISOString(), r.total]));
    const months = Array.from(new Set([...ledgerMap.keys(), ...rollupMap.keys()]))
      .sort()
      .reverse();
    const rows = months.map((m) => {
      const ledgerTotal = ledgerMap.get(m) ?? '0';
      const rollupTotal = rollupMap.get(m) ?? '0';
      const drift = (Number(rollupTotal) - Number(ledgerTotal)).toFixed(2);
      return {
        month: m,
        ledgerTotal,
        rollupTotal,
        drift,
        drifted: Math.abs(Number(drift)) > 0.005,
      };
    });
    const driftedCount = rows.filter((r) => r.drifted).length;
    return {
      months: rows,
      summary: {
        monthsTracked: rows.length,
        driftedMonths: driftedCount,
        allClean: driftedCount === 0,
      },
      generatedAt: new Date().toISOString(),
    };
  });

  // ─── Lender deep-dive (per-month + APR distribution) ─────────────────────
  app.get('/lenders/:name/timeline', { preHandler: requireAuth }, async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const monthly = await prisma.$queryRaw<
      Array<{
        bucket: Date;
        submitted: bigint;
        approved: bigint;
        funded: bigint;
        avg_apr: string | null;
        funded_amount: string;
      }>
    >(Prisma.sql`
        SELECT date_trunc('month', decision_timestamp) AS bucket,
               COUNT(*)::bigint AS submitted,
               COUNT(*) FILTER (WHERE decision='APPROVED')::bigint AS approved,
               COUNT(*) FILTER (WHERE funding_status='FUNDED')::bigint AS funded,
               AVG(apr)::text AS avg_apr,
               COALESCE(SUM(funding_amount), 0)::text AS funded_amount
        FROM lender_decisions
        WHERE lender_name = ${params.name}
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT 24
      `);
    const aprBuckets = await prisma.$queryRaw<Array<{ bucket: number; n: bigint }>>(Prisma.sql`
        SELECT CASE
                 WHEN apr < 10 THEN 0
                 WHEN apr < 15 THEN 10
                 WHEN apr < 20 THEN 15
                 WHEN apr < 25 THEN 20
                 WHEN apr < 30 THEN 25
                 ELSE 30
               END AS bucket,
               COUNT(*)::bigint AS n
        FROM lender_decisions
        WHERE lender_name = ${params.name} AND apr IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket
      `);
    const recent = await prisma.lenderDecision.findMany({
      where: { lenderName: params.name },
      orderBy: { decisionTimestamp: 'desc' },
      take: 50,
      include: { application: { select: { externalApplicationId: true } } },
    });
    return {
      lenderName: params.name,
      monthly: monthly.map((m) => ({
        bucket: m.bucket.toISOString(),
        submitted: Number(m.submitted),
        approved: Number(m.approved),
        funded: Number(m.funded),
        avgApr: m.avg_apr,
        fundedAmount: m.funded_amount,
      })),
      aprDistribution: aprBuckets.map((b) => ({
        bucketLabel: `${b.bucket}–${b.bucket + 5}%`,
        count: Number(b.n),
      })),
      recentDecisions: recent.map((d) => ({
        id: d.id,
        externalApplicationId: d.application.externalApplicationId,
        decision: d.decision,
        decisionTimestamp: d.decisionTimestamp.toISOString(),
        apr: d.apr?.toString() ?? null,
        approvalAmount: d.approvalAmount?.toString() ?? null,
        fundingStatus: d.fundingStatus,
        fundingAmount: d.fundingAmount?.toString() ?? null,
      })),
    };
  });
}
