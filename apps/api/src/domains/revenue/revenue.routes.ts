import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrismaReader } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { denyInvestorScope } from '../../shared/middleware/rbac.middleware.js';
import { partnerLabel } from '../partners/partner.types.js';
import { RevenueRepository } from './revenue.repository.js';
import { RevenueService } from './revenue.service.js';
import { RevenueByStreamQuerySchema, RevenueLedgerQuerySchema } from './revenue.schemas.js';

const RangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function registerRevenueRoutes(app: FastifyInstance): Promise<void> {
  const service = new RevenueService(new RevenueRepository(getPrismaReader()));

  app.get('/revenue/ledger', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const query = RevenueLedgerQuerySchema.parse(req.query);
    const page = await service.ledger(query);
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
    return service.byStream(query);
  });

  app.get('/revenue/by-partner', { preHandler: requireAuth }, async (req) => {
    const q = RangeQuery.parse(req.query);
    const rows = await service.byPartner({ from: q.from, to: q.to, limit: q.limit });
    const isInvestor = req.auth!.scope === 'investor';
    return rows.map((r) => ({
      partnerId: r.partnerId,
      partnerLabel: isInvestor ? partnerLabel(r.partnerId) : r.partnerName,
      total: r.total,
    }));
  });

  app.get('/revenue/clawbacks', { preHandler: [requireAuth, denyInvestorScope] }, async (req) => {
    const q = RangeQuery.parse(req.query);
    const rows = await service.clawbacks({ from: q.from, to: q.to });
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
