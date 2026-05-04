import type { Application, ApplicationStatus, Prisma, PrismaClient } from '@prisma/client';

export interface ListApplicationsFilter {
  partnerId?: string;
  status?: ApplicationStatus;
  from?: Date;
  to?: Date;
  cursor?: { createdAt: Date; id: string };
  limit: number;
}

export interface IApplicationRepository {
  findById(id: string): Promise<Application | null>;
  list(filter: ListApplicationsFilter): Promise<Application[]>;
  upsertFromWebhook(args: {
    externalApplicationId: string;
    data: Prisma.ApplicationUncheckedCreateInput;
  }): Promise<Application>;
}

export class ApplicationRepository implements IApplicationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<Application | null> {
    return this.prisma.application.findUnique({ where: { id } });
  }

  async list(filter: ListApplicationsFilter): Promise<Application[]> {
    const where: Prisma.ApplicationWhereInput = {};
    if (filter.partnerId) where.partnerId = filter.partnerId;
    if (filter.status) where.status = filter.status;
    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt.gte = filter.from;
      if (filter.to) where.createdAt.lte = filter.to;
    }
    if (filter.cursor) {
      where.OR = [
        { createdAt: { lt: filter.cursor.createdAt } },
        { AND: [{ createdAt: filter.cursor.createdAt }, { id: { lt: filter.cursor.id } }] },
      ];
    }
    return this.prisma.application.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }

  async upsertFromWebhook(args: {
    externalApplicationId: string;
    data: Prisma.ApplicationUncheckedCreateInput;
  }): Promise<Application> {
    return this.prisma.application.upsert({
      where: { externalApplicationId: args.externalApplicationId },
      create: args.data,
      update: {
        status: args.data.status,
        submittedAt: args.data.submittedAt ?? undefined,
        creditScore: args.data.creditScore ?? undefined,
        availableCredit: args.data.availableCredit ?? undefined,
        notedAnnualIncome: args.data.notedAnnualIncome ?? undefined,
        bankStatementsProvided: args.data.bankStatementsProvided ?? undefined,
        merchantPreapproval: args.data.merchantPreapproval ?? undefined,
        merchantPreapprovalAmount: args.data.merchantPreapprovalAmount ?? undefined,
        consumerPreapproval: args.data.consumerPreapproval ?? undefined,
        consumerPreapprovalAmount: args.data.consumerPreapprovalAmount ?? undefined,
        fundingEstimate: args.data.fundingEstimate ?? undefined,
        propensityScore: args.data.propensityScore ?? undefined,
        openLinesOfCredit: args.data.openLinesOfCredit ?? undefined,
      },
    });
  }
}
