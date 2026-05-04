import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { PixieRepository } from './pixie.repository.js';
import { PixieService } from './pixie.service.js';
import { PixieUsageQuerySchema } from './pixie.schemas.js';

export async function registerPixieRoutes(app: FastifyInstance): Promise<void> {
  const service = new PixieService(new PixieRepository(getPrisma()));

  app.get('/pixie/usage', { preHandler: requireAuth }, async (req) => {
    const query = PixieUsageQuerySchema.parse(req.query);
    return service.usage(query);
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
