import type { LenderDecision, LenderTier, Prisma, PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

export interface ILenderRepository {
  upsertFromWebhook(args: {
    applicationId: string;
    partnerId: string;
    externalKey: string;
    data: Prisma.LenderDecisionUncheckedCreateInput;
  }): Promise<LenderDecision>;
  findByExternalKey(externalKey: string): Promise<LenderDecision | null>;
  waterfall(filter: {
    orgId: string;
    from?: Date;
    to?: Date;
    tier?: LenderTier;
  }): Promise<WaterfallAggregate[]>;
}

export interface WaterfallAggregate {
  lenderName: string;
  lenderTier: LenderTier;
  submitted: number;
  approved: number;
  declined: number;
  funded: number;
  avgApr: string | null;
  totalFunded: string;
}

export class LenderRepository implements ILenderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByExternalKey(externalKey: string): Promise<LenderDecision | null> {
    // External key encoded into id field's source via webhook payload.
    return this.prisma.lenderDecision.findFirst({
      where: { id: externalKey },
    });
  }

  async upsertFromWebhook(args: {
    applicationId: string;
    partnerId: string;
    externalKey: string;
    data: Prisma.LenderDecisionUncheckedCreateInput;
  }): Promise<LenderDecision> {
    const id = args.data.id ?? uuidv7();
    return this.prisma.lenderDecision.upsert({
      where: { id },
      create: { ...args.data, id, applicationId: args.applicationId, partnerId: args.partnerId },
      update: {
        decision: args.data.decision,
        decisionTimestamp: args.data.decisionTimestamp,
        approvalAmount: args.data.approvalAmount ?? undefined,
        apr: args.data.apr ?? undefined,
        term: args.data.term ?? undefined,
        monthlyPayment: args.data.monthlyPayment ?? undefined,
        originationFee: args.data.originationFee ?? undefined,
        fundingStatus: args.data.fundingStatus ?? undefined,
        fundingTimestamp: args.data.fundingTimestamp ?? undefined,
        fundingAmount: args.data.fundingAmount ?? undefined,
      },
    });
  }

  async waterfall(filter: {
    orgId: string;
    from?: Date;
    to?: Date;
    tier?: LenderTier;
  }): Promise<WaterfallAggregate[]> {
    const where: Prisma.LenderDecisionWhereInput = { orgId: filter.orgId };
    if (filter.tier) where.lenderTier = filter.tier;
    if (filter.from || filter.to) {
      where.decisionTimestamp = {};
      if (filter.from) where.decisionTimestamp.gte = filter.from;
      if (filter.to) where.decisionTimestamp.lte = filter.to;
    }
    const grouped = await this.prisma.lenderDecision.groupBy({
      by: ['lenderName', 'lenderTier'],
      where,
      _count: { _all: true },
      _avg: { apr: true },
      _sum: { fundingAmount: true },
    });

    const results: WaterfallAggregate[] = [];
    for (const g of grouped) {
      const [approved, declined, funded] = await Promise.all([
        this.prisma.lenderDecision.count({
          where: { ...where, lenderName: g.lenderName, decision: 'APPROVED' },
        }),
        this.prisma.lenderDecision.count({
          where: { ...where, lenderName: g.lenderName, decision: 'DECLINED' },
        }),
        this.prisma.lenderDecision.count({
          where: { ...where, lenderName: g.lenderName, fundingStatus: 'FUNDED' },
        }),
      ]);
      results.push({
        lenderName: g.lenderName,
        lenderTier: g.lenderTier,
        submitted: g._count._all,
        approved,
        declined,
        funded,
        avgApr: g._avg.apr?.toString() ?? null,
        totalFunded: (g._sum.fundingAmount ?? '0').toString(),
      });
    }
    return results.sort((a, b) => b.funded - a.funded);
  }
}
