import { Prisma, type PrismaClient } from '@prisma/client';

export interface IAnalyticsRepository {
  totalRevenue(args: { from: Date; to: Date }): Promise<string>;
  approvalRate(args: { from: Date; to: Date }): Promise<{ approved: number; total: number }>;
  fundingRate(args: { from: Date; to: Date }): Promise<{ funded: number; approved: number }>;
  activePartnerCount(args: { since: Date }): Promise<number>;
  pixiePullsLast24h(): Promise<number>;
  cohorts(): Promise<CohortRow[]>;
  funnel(args: { from: Date; to: Date }): Promise<FunnelCounts>;
  partnerLeaderboard(args: { from: Date; to: Date; limit: number }): Promise<LeaderboardRow[]>;
  tierBreakdown(): Promise<Array<{ tier: string; count: number }>>;
  liveTail(limit: number): Promise<LiveEvent[]>;
}

export interface CohortRow {
  cohortMonth: string;
  monthsSinceOnboard: number;
  partnerCount: number;
  retainedCount: number;
  revenue: string;
}

export interface FunnelCounts {
  submitted: number;
  approved: number;
  funded: number;
}

export interface LeaderboardRow {
  partnerId: string;
  partnerName: string;
  tier: string;
  applications: number;
  approved: number;
  funded: number;
  revenue: string;
}

export interface LiveEvent {
  eventTime: string;
  kind: 'application' | 'decision' | 'funding' | 'revenue' | 'partner';
  partnerId: string;
  partnerName: string;
  description: string;
  amount: string | null;
}

export class AnalyticsRepository implements IAnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async totalRevenue(args: { from: Date; to: Date }): Promise<string> {
    const sum = await this.prisma.revenueEvent.aggregate({
      where: { effectiveAt: { gte: args.from, lte: args.to } },
      _sum: { amount: true },
    });
    return (sum._sum.amount ?? '0').toString();
  }

  async approvalRate(args: { from: Date; to: Date }): Promise<{ approved: number; total: number }> {
    const [approved, total] = await Promise.all([
      this.prisma.lenderDecision.count({
        where: { decision: 'APPROVED', decisionTimestamp: { gte: args.from, lte: args.to } },
      }),
      this.prisma.lenderDecision.count({
        where: { decisionTimestamp: { gte: args.from, lte: args.to } },
      }),
    ]);
    return { approved, total };
  }

  async fundingRate(args: { from: Date; to: Date }): Promise<{ funded: number; approved: number }> {
    const [funded, approved] = await Promise.all([
      this.prisma.lenderDecision.count({
        where: { fundingStatus: 'FUNDED', fundingTimestamp: { gte: args.from, lte: args.to } },
      }),
      this.prisma.lenderDecision.count({
        where: { decision: 'APPROVED', decisionTimestamp: { gte: args.from, lte: args.to } },
      }),
    ]);
    return { funded, approved };
  }

  async activePartnerCount(args: { since: Date }): Promise<number> {
    const rows = await this.prisma.application.findMany({
      where: { createdAt: { gte: args.since }, partner: { status: 'ACTIVE', deletedAt: null } },
      select: { partnerId: true },
      distinct: ['partnerId'],
    });
    return rows.length;
  }

  async pixiePullsLast24h(): Promise<number> {
    const since = new Date(Date.now() - 86_400_000);
    const sum = await this.prisma.pixieMetric.aggregate({
      where: { period: 'DAILY', periodStart: { gte: since } },
      _sum: { dataPullsThisPeriod: true },
    });
    return sum._sum.dataPullsThisPeriod ?? 0;
  }

  async cohorts(): Promise<CohortRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ cohort_month: string; months_since: number; partner_count: bigint; retained_count: bigint; revenue: string }>
    >(Prisma.sql`
      WITH cohorts AS (
        SELECT id AS partner_id,
               date_trunc('month', onboarding_date) AS cohort_month
        FROM partners
        WHERE deleted_at IS NULL
      ),
      activity AS (
        SELECT a.partner_id,
               date_trunc('month', a.created_at) AS activity_month
        FROM applications a
      ),
      revenue AS (
        SELECT partner_id, date_trunc('month', effective_at) AS rev_month, SUM(amount) AS amt
        FROM revenue_events
        GROUP BY 1, 2
      )
      SELECT to_char(c.cohort_month, 'YYYY-MM') AS cohort_month,
             EXTRACT(YEAR FROM age(act.activity_month, c.cohort_month))::int * 12
              + EXTRACT(MONTH FROM age(act.activity_month, c.cohort_month))::int AS months_since,
             COUNT(DISTINCT c.partner_id)::bigint AS partner_count,
             COUNT(DISTINCT CASE WHEN act.partner_id IS NOT NULL THEN c.partner_id END)::bigint AS retained_count,
             COALESCE(SUM(r.amt), 0)::text AS revenue
      FROM cohorts c
      LEFT JOIN activity act ON act.partner_id = c.partner_id
      LEFT JOIN revenue  r   ON r.partner_id   = c.partner_id AND r.rev_month = act.activity_month
      GROUP BY c.cohort_month, months_since
      ORDER BY c.cohort_month ASC, months_since ASC
    `);
    return rows.map((r) => ({
      cohortMonth: r.cohort_month,
      monthsSinceOnboard: Number(r.months_since ?? 0),
      partnerCount: Number(r.partner_count),
      retainedCount: Number(r.retained_count),
      revenue: r.revenue,
    }));
  }

  async funnel(args: { from: Date; to: Date }): Promise<FunnelCounts> {
    const [submitted, approved, funded] = await Promise.all([
      this.prisma.application.count({
        where: { submittedAt: { gte: args.from, lte: args.to } },
      }),
      this.prisma.application.count({
        where: { status: { in: ['APPROVED', 'FUNDED'] }, createdAt: { gte: args.from, lte: args.to } },
      }),
      this.prisma.application.count({
        where: { status: 'FUNDED', createdAt: { gte: args.from, lte: args.to } },
      }),
    ]);
    return { submitted, approved, funded };
  }

  async partnerLeaderboard(args: { from: Date; to: Date; limit: number }): Promise<LeaderboardRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        partner_id: string;
        partner_name: string;
        tier: string;
        applications: bigint;
        approved: bigint;
        funded: bigint;
        revenue: string;
      }>
    >(Prisma.sql`
      SELECT p.id AS partner_id,
             p.name AS partner_name,
             p.tier::text AS tier,
             COUNT(DISTINCT a.id)::bigint AS applications,
             COUNT(DISTINCT CASE WHEN a.status IN ('APPROVED','FUNDED') THEN a.id END)::bigint AS approved,
             COUNT(DISTINCT CASE WHEN a.status='FUNDED' THEN a.id END)::bigint AS funded,
             COALESCE(SUM(re.amount), 0)::text AS revenue
      FROM partners p
      LEFT JOIN applications  a  ON a.partner_id  = p.id AND a.created_at  BETWEEN ${args.from}::timestamptz AND ${args.to}::timestamptz
      LEFT JOIN revenue_events re ON re.partner_id = p.id AND re.effective_at BETWEEN ${args.from} AND ${args.to}
      WHERE p.deleted_at IS NULL
      GROUP BY p.id, p.name, p.tier
      ORDER BY revenue DESC
      LIMIT ${args.limit}
    `);
    return rows.map((r) => ({
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      tier: r.tier,
      applications: Number(r.applications),
      approved: Number(r.approved),
      funded: Number(r.funded),
      revenue: r.revenue,
    }));
  }

  async tierBreakdown(): Promise<Array<{ tier: string; count: number }>> {
    const rows = await this.prisma.partner.groupBy({
      by: ['tier'],
      where: { deletedAt: null, status: 'ACTIVE' },
      _count: { _all: true },
    });
    return rows.map((r) => ({ tier: r.tier, count: r._count._all }));
  }

  async liveTail(limit: number): Promise<LiveEvent[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ event_time: Date; kind: string; partner_id: string; partner_name: string; description: string; amount: string | null }>
    >(Prisma.sql`
      (SELECT a.created_at AS event_time, 'application' AS kind, a.partner_id, p.name AS partner_name,
              'Application '||a.external_application_id||' · '||a.status::text AS description,
              NULL::text AS amount
       FROM applications a JOIN partners p ON p.id=a.partner_id
       ORDER BY a.created_at DESC LIMIT ${limit})
      UNION ALL
      (SELECT decision_timestamp AS event_time, 'decision' AS kind, ld.partner_id, p.name,
              ld.lender_name||' '||ld.decision::text,
              ld.approval_amount::text
       FROM lender_decisions ld JOIN partners p ON p.id=ld.partner_id
       ORDER BY decision_timestamp DESC LIMIT ${limit})
      UNION ALL
      (SELECT funding_timestamp AS event_time, 'funding' AS kind, ld.partner_id, p.name,
              'Funding '||ld.funding_status::text,
              ld.funding_amount::text
       FROM lender_decisions ld JOIN partners p ON p.id=ld.partner_id
       WHERE funding_timestamp IS NOT NULL
       ORDER BY funding_timestamp DESC LIMIT ${limit})
      UNION ALL
      (SELECT effective_at AS event_time, 'revenue' AS kind, re.partner_id, p.name,
              re.stream::text||' '||re.event_type::text,
              re.amount::text
       FROM revenue_events re JOIN partners p ON p.id=re.partner_id
       ORDER BY effective_at DESC LIMIT ${limit})
      ORDER BY event_time DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      eventTime: r.event_time.toISOString(),
      kind: r.kind as LiveEvent['kind'],
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      description: r.description,
      amount: r.amount,
    }));
  }
}
