import type { AggregationPeriod, PixieMetric, Prisma, PrismaClient } from '@prisma/client';

export interface IPixieRepository {
  list(filter: { partnerId?: string; period: AggregationPeriod; from?: Date; to?: Date }): Promise<PixieMetric[]>;
  collectiveLast24h(): Promise<{ pulls: number }>;
}

export class PixieRepository implements IPixieRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(filter: { partnerId?: string; period: AggregationPeriod; from?: Date; to?: Date }): Promise<PixieMetric[]> {
    const where: Prisma.PixieMetricWhereInput = { period: filter.period };
    if (filter.partnerId) where.partnerId = filter.partnerId;
    if (filter.from || filter.to) {
      where.periodStart = {};
      if (filter.from) where.periodStart.gte = filter.from;
      if (filter.to) where.periodStart.lte = filter.to;
    }
    return this.prisma.pixieMetric.findMany({ where, orderBy: { periodStart: 'desc' }, take: 365 });
  }

  async collectiveLast24h(): Promise<{ pulls: number }> {
    const since = new Date(Date.now() - 86_400_000);
    const sum = await this.prisma.pixieMetric.aggregate({
      where: { period: 'DAILY', periodStart: { gte: since } },
      _sum: { dataPullsThisPeriod: true },
    });
    return { pulls: sum._sum.dataPullsThisPeriod ?? 0 };
  }
}
