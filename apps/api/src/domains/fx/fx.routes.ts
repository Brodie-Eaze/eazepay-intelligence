/**
 * FX rate admin endpoints.
 *
 * POST /admin/fx-rates       — push a rate (admin + CSRF)
 * POST /admin/fx-rates/bulk  — push N rates in one batch (daily ECB feed, etc.)
 * GET  /admin/fx-rates       — list, filter by currency pair / date window
 *
 * Rates are pushed by either an internal cron pulling from the ECB / a
 * commercial feed, or manually by an operator during a deployment cutover.
 * Either way the source is recorded in the row + audit log so a future
 * reconciliation can answer "where did this rate come from?"
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getPrismaWriter } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';

const isoCurrency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);

const SubmitBody = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  baseCurrency: isoCurrency,
  quoteCurrency: isoCurrency,
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  source: z.string().max(64).default('manual'),
});

const BulkBody = z.object({
  rates: z.array(SubmitBody).min(1).max(1000),
});

const ListQuery = z.object({
  base: isoCurrency.optional(),
  quote: isoCurrency.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function registerFxRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrismaWriter();

  app.post(
    '/admin/fx-rates',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const body = SubmitBody.parse(req.body);
      const created = await prisma.fxRate.upsert({
        where: {
          asOf_baseCurrency_quoteCurrency: {
            asOf: new Date(body.asOf),
            baseCurrency: body.baseCurrency,
            quoteCurrency: body.quoteCurrency,
          },
        },
        create: {
          id: uuidv7(),
          asOf: new Date(body.asOf),
          baseCurrency: body.baseCurrency,
          quoteCurrency: body.quoteCurrency,
          rate: body.rate,
          source: body.source,
        },
        update: { rate: body.rate, source: body.source },
      });
      await writeAuditLog({
        req,
        action: 'FX_RATE_INGESTED',
        resourceType: 'fx_rate',
        resourceId: created.id,
        metadata: {
          asOf: body.asOf,
          base: body.baseCurrency,
          quote: body.quoteCurrency,
          rate: body.rate,
          source: body.source,
        },
      });
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/admin/fx-rates/bulk',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const body = BulkBody.parse(req.body);
      let upserted = 0;
      for (const r of body.rates) {
        await prisma.fxRate.upsert({
          where: {
            asOf_baseCurrency_quoteCurrency: {
              asOf: new Date(r.asOf),
              baseCurrency: r.baseCurrency,
              quoteCurrency: r.quoteCurrency,
            },
          },
          create: {
            id: uuidv7(),
            asOf: new Date(r.asOf),
            baseCurrency: r.baseCurrency,
            quoteCurrency: r.quoteCurrency,
            rate: r.rate,
            source: r.source,
          },
          update: { rate: r.rate, source: r.source },
        });
        upserted += 1;
      }
      await writeAuditLog({
        req,
        action: 'FX_RATE_INGESTED',
        resourceType: 'fx_rate_batch',
        metadata: { count: upserted },
      });
      return { upserted };
    },
  );

  app.get('/admin/fx-rates', { preHandler: [requireAuth, requireRole('ADMIN')] }, async (req) => {
    const q = ListQuery.parse(req.query);
    return prisma.fxRate.findMany({
      where: {
        ...(q.base ? { baseCurrency: q.base } : {}),
        ...(q.quote ? { quoteCurrency: q.quote } : {}),
        ...(q.from || q.to
          ? {
              asOf: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ asOf: 'desc' }, { baseCurrency: 'asc' }, { quoteCurrency: 'asc' }],
      take: q.limit,
    });
  });
}
