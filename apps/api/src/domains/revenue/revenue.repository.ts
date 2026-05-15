import {
  Prisma,
  type PrismaClient,
  type RevenueEvent,
  type RevenueEventType,
  type RevenueStream,
} from '@prisma/client';

/**
 * Revenue ledger repository.
 *
 * GAP-108: every read scopes to `orgId`. Today's RLS migrations enforce
 * this at the DB level under the eazepay_app role, but the application
 * layer also filters explicitly so a tenant's queries cannot leak across
 * orgs even if RLS is disabled or bypassed on a particular connection
 * (e.g., reader replica without role flip).
 */

export interface LedgerFilter {
  orgId: string;
  partnerId?: string;
  stream?: RevenueStream;
  eventType?: RevenueEventType;
  from?: Date;
  to?: Date;
  cursor?: { effectiveAt: Date; idempotencyKey: string };
  limit: number;
}

export interface IRevenueRepository {
  list(filter: LedgerFilter): Promise<RevenueEvent[]>;
  sumByStream(args: {
    orgId: string;
    from?: Date;
    to?: Date;
    bucket: 'day' | 'week' | 'month';
  }): Promise<RevenueByStreamRow[]>;
  topPartners(args: {
    orgId: string;
    from?: Date;
    to?: Date;
    limit: number;
  }): Promise<TopPartnerRow[]>;
  total(args: { orgId: string; from?: Date; to?: Date; partnerId?: string }): Promise<string>;
  clawbacks(args: { orgId: string; from?: Date; to?: Date }): Promise<RevenueEvent[]>;
}

export interface RevenueByStreamRow {
  bucket: string;
  stream: RevenueStream;
  amount: string;
}

export interface TopPartnerRow {
  partnerId: string;
  partnerName: string;
  total: string;
}

export class RevenueRepository implements IRevenueRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(filter: LedgerFilter): Promise<RevenueEvent[]> {
    const where: Prisma.RevenueEventWhereInput = { orgId: filter.orgId };
    if (filter.partnerId) where.partnerId = filter.partnerId;
    if (filter.stream) where.stream = filter.stream;
    if (filter.eventType) where.eventType = filter.eventType;
    if (filter.from || filter.to) {
      where.effectiveAt = {};
      if (filter.from) where.effectiveAt.gte = filter.from;
      if (filter.to) where.effectiveAt.lte = filter.to;
    }
    if (filter.cursor) {
      where.OR = [
        { effectiveAt: { lt: filter.cursor.effectiveAt } },
        {
          AND: [
            { effectiveAt: filter.cursor.effectiveAt },
            { idempotencyKey: { lt: filter.cursor.idempotencyKey } },
          ],
        },
      ];
    }
    return this.prisma.revenueEvent.findMany({
      where,
      orderBy: [{ effectiveAt: 'desc' }, { idempotencyKey: 'desc' }],
      take: filter.limit + 1,
    });
  }

  async sumByStream(args: {
    orgId: string;
    from?: Date;
    to?: Date;
    bucket: 'day' | 'week' | 'month';
  }): Promise<RevenueByStreamRow[]> {
    const truncMap = { day: 'day', week: 'week', month: 'month' } as const;
    const trunc = truncMap[args.bucket];
    const fromCond = args.from ? Prisma.sql`AND effective_at >= ${args.from}` : Prisma.empty;
    const toCond = args.to ? Prisma.sql`AND effective_at <= ${args.to}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { bucket: Date; stream: RevenueStream; amount: string }[]
    >(
      Prisma.sql`
        SELECT date_trunc(${trunc}, effective_at) AS bucket,
               stream,
               COALESCE(SUM(amount), 0)::text AS amount
        FROM revenue_events
        WHERE org_id = ${args.orgId}::uuid ${fromCond} ${toCond}
        GROUP BY bucket, stream
        ORDER BY bucket ASC
      `,
    );
    return rows.map((r) => ({
      bucket: r.bucket.toISOString(),
      stream: r.stream,
      amount: r.amount,
    }));
  }

  async topPartners(args: {
    orgId: string;
    from?: Date;
    to?: Date;
    limit: number;
  }): Promise<TopPartnerRow[]> {
    const fromCond = args.from ? Prisma.sql`AND r.effective_at >= ${args.from}` : Prisma.empty;
    const toCond = args.to ? Prisma.sql`AND r.effective_at <= ${args.to}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { partner_id: string; partner_name: string; total: string }[]
    >(
      Prisma.sql`
        SELECT r.partner_id, p.name AS partner_name, COALESCE(SUM(r.amount), 0)::text AS total
        FROM revenue_events r
        JOIN partners p ON p.id = r.partner_id
        WHERE r.org_id = ${args.orgId}::uuid ${fromCond} ${toCond}
        GROUP BY r.partner_id, p.name
        ORDER BY SUM(r.amount) DESC
        LIMIT ${args.limit}
      `,
    );
    return rows.map((r) => ({
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      total: r.total,
    }));
  }

  async total(args: {
    orgId: string;
    from?: Date;
    to?: Date;
    partnerId?: string;
  }): Promise<string> {
    const where: Prisma.RevenueEventWhereInput = { orgId: args.orgId };
    if (args.partnerId) where.partnerId = args.partnerId;
    if (args.from || args.to) {
      where.effectiveAt = {};
      if (args.from) where.effectiveAt.gte = args.from;
      if (args.to) where.effectiveAt.lte = args.to;
    }
    const sum = await this.prisma.revenueEvent.aggregate({ where, _sum: { amount: true } });
    return (sum._sum.amount ?? '0').toString();
  }

  async clawbacks(args: { orgId: string; from?: Date; to?: Date }): Promise<RevenueEvent[]> {
    const where: Prisma.RevenueEventWhereInput = {
      orgId: args.orgId,
      eventType: { in: ['CLAWBACK', 'REVERSAL'] },
    };
    if (args.from || args.to) {
      where.effectiveAt = {};
      if (args.from) where.effectiveAt.gte = args.from;
      if (args.to) where.effectiveAt.lte = args.to;
    }
    return this.prisma.revenueEvent.findMany({
      where,
      orderBy: { effectiveAt: 'desc' },
      take: 200,
    });
  }
}
