import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrismaReader } from '../../config/database.js';
import { errors } from '../../shared/errors/app-error.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { denyInvestorScope } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { rowsToCsv, attachmentHeader } from '../../shared/utils/csv.js';
import { partnerLabel } from '../partners/partner.types.js';
import { RevenueRepository } from './revenue.repository.js';
import { RevenueService } from './revenue.service.js';
import { RevenueByStreamQuerySchema, RevenueLedgerQuerySchema } from './revenue.schemas.js';

const RangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** GAP-108: revenue surfaces are org-scoped. Mirror of analytics.routes. */
function requireOrgScope(orgId: string | undefined): string {
  if (!orgId) throw errors.badRequest('Revenue queries require an active organisation');
  return orgId;
}

export async function registerRevenueRoutes(app: FastifyInstance): Promise<void> {
  const service = new RevenueService(new RevenueRepository(getPrismaReader()));

  app.get('/revenue/ledger', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const query = RevenueLedgerQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    const page = await service.ledger(orgId, query);
    return {
      data: page.data.map((r) => ({
        idempotencyKey: r.idempotencyKey,
        partnerId: r.partnerId,
        lenderDecisionId: r.lenderDecisionId,
        source: r.source,
        stream: r.stream,
        eventType: r.eventType,
        amount: r.amount.toString(),
        currency: r.currency,
        effectiveAt: r.effectiveAt.toISOString(),
        recordedAt: r.recordedAt.toISOString(),
        metadata: r.metadata,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });

  app.get('/revenue/by-stream', { preHandler: requireAuth }, async (req) => {
    const query = RevenueByStreamQuerySchema.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    return service.byStream(orgId, query);
  });

  app.get('/revenue/by-partner', { preHandler: requireAuth }, async (req) => {
    const q = RangeQuery.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    const rows = await service.byPartner(orgId, { from: q.from, to: q.to, limit: q.limit });
    const isInvestor = req.auth!.scope === 'investor';
    return rows.map((r) => ({
      partnerId: r.partnerId,
      partnerLabel: isInvestor ? partnerLabel(r.partnerId) : r.partnerName,
      total: r.total,
    }));
  });

  // ─── Export — revenue ledger as CSV / JSON ────────────────────────────
  //
  // Reuses the ledger query (stream / partner / from / to). Default cap
  // 50k rows. Always audited as DATA_EXPORTED.
  const ExportQuery = RevenueLedgerQuerySchema.omit({ limit: true, cursor: true }).extend({
    format: z.enum(['csv', 'json']).default('csv'),
  });

  app.get(
    '/revenue/ledger/export',
    { preHandler: [requireAuth, denyInvestorScope] },
    async (req, reply) => {
      const q = ExportQuery.parse(req.query);
      const orgId = requireOrgScope(req.auth?.orgId);
      // Pull all rows matching the filter (one page, large cap)
      const page = await service.ledger(orgId, { ...q, limit: 50_000, cursor: undefined });

      await writeAuditLog({
        req,
        action: 'DATA_EXPORTED',
        resourceType: 'revenue_event',
        metadata: {
          source: q.stream ?? 'all',
          format: q.format,
          rowCount: page.data.length,
          filters: {
            stream: q.stream ?? null,
            partnerId: q.partnerId ?? null,
            from: q.from ?? null,
            to: q.to ?? null,
          },
        },
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const streamTag = q.stream ? `_${q.stream.toLowerCase()}` : '';
      const filename = `revenue_ledger${streamTag}_${timestamp}.${q.format}`;

      const columns: Array<{ key: string; pick?: (r: (typeof page.data)[number]) => unknown }> = [
        { key: 'idempotency_key', pick: (r) => r.idempotencyKey },
        { key: 'partner_id', pick: (r) => r.partnerId },
        { key: 'lender_decision_id', pick: (r) => r.lenderDecisionId },
        { key: 'source', pick: (r) => r.source },
        { key: 'stream', pick: (r) => r.stream },
        { key: 'event_type', pick: (r) => r.eventType },
        { key: 'amount', pick: (r) => r.amount.toString() },
        { key: 'currency', pick: (r) => r.currency },
        { key: 'effective_at', pick: (r) => r.effectiveAt.toISOString() },
        { key: 'recorded_at', pick: (r) => r.recordedAt.toISOString() },
        { key: 'metadata', pick: (r) => (r.metadata ? JSON.stringify(r.metadata) : null) },
      ];

      if (q.format === 'json') {
        reply.header('Content-Type', 'application/json');
        reply.header('Content-Disposition', attachmentHeader(filename));
        return page.data.map((r) => {
          const obj: Record<string, unknown> = {};
          for (const c of columns) obj[c.key] = c.pick ? c.pick(r) : null;
          return obj;
        });
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', attachmentHeader(filename));
      return rowsToCsv(page.data, columns);
    },
  );

  app.get('/revenue/clawbacks', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const q = RangeQuery.parse(req.query);
    const orgId = requireOrgScope(req.auth?.orgId);
    const rows = await service.clawbacks(orgId, { from: q.from, to: q.to });
    return rows.map((r) => ({
      idempotencyKey: r.idempotencyKey,
      partnerId: r.partnerId,
      stream: r.stream,
      eventType: r.eventType,
      amount: r.amount.toString(),
      effectiveAt: r.effectiveAt.toISOString(),
      metadata: r.metadata,
    }));
  });
}
