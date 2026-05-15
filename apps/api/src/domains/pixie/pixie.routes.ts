import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { rowsToCsv, attachmentHeader } from '../../shared/utils/csv.js';
import { PixieRepository } from './pixie.repository.js';
import { PixieService } from './pixie.service.js';
import { PixieUsageQuerySchema } from './pixie.schemas.js';

export async function registerPixieRoutes(app: FastifyInstance): Promise<void> {
  const service = new PixieService(new PixieRepository(getPrisma()));

  app.get('/pixie/usage', { preHandler: requireAuth }, async (req) => {
    const query = PixieUsageQuerySchema.parse(req.query);
    return service.usage(query);
  });

  // ─── Export — Pixie usage as CSV / JSON ────────────────────────────────
  app.get('/pixie/usage/export', { preHandler: requireAuth }, async (req, reply) => {
    const usageQuery = PixieUsageQuerySchema.parse(req.query);
    const fmt = z
      .object({ format: z.enum(['csv', 'json']).default('csv') })
      .parse(req.query).format;

    const rows = await service.usage(usageQuery);

    await writeAuditLog({
      req,
      action: 'DATA_EXPORTED',
      resourceType: 'pixie_metric',
      metadata: {
        source: 'pixie',
        format: fmt,
        rowCount: rows.length,
        filters: { period: usageQuery.period ?? null },
      },
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `pixie_usage_${timestamp}.${fmt}`;

    if (fmt === 'json') {
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', attachmentHeader(filename));
      return rows;
    }

    const first = rows[0] ?? {};
    const columns = Object.keys(first).map((k) => ({
      key: k,
      pick: (r: Record<string, unknown>) => r[k],
    }));

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', attachmentHeader(filename));
    return rowsToCsv(rows as Record<string, unknown>[], columns);
  });

  app.get('/pixie/breakpoint-status', { preHandler: requireAuth }, async () => {
    return service.breakpointStatus();
  });

  app.get('/pixie/margin', { preHandler: requireAuth }, async () => {
    const prisma = getPrisma();
    const since = new Date(Date.now() - 30 * 86_400_000);
    const sum = await prisma.pixieMetric.aggregate({
      where: { period: 'DAILY', periodStart: { gte: since } },
      _sum: { totalRevenue: true, dataPullsThisPeriod: true },
    });
    return {
      windowDays: 30,
      totalMargin: (sum._sum.totalRevenue ?? '0').toString(),
      totalPulls: sum._sum.dataPullsThisPeriod ?? 0,
    };
  });
}
