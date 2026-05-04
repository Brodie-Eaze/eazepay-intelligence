import type { Partner, PartnerStatus, PartnerTier, Prisma, PrismaClient } from '@prisma/client';

export interface ListPartnersFilter {
  status?: PartnerStatus;
  tier?: PartnerTier;
  q?: string;
  cursor?: { createdAt: Date; id: string };
  limit: number;
}

export interface IPartnerRepository {
  findById(id: string): Promise<Partner | null>;
  findByExternalId(externalId: string): Promise<Partner | null>;
  list(filter: ListPartnersFilter): Promise<Partner[]>;
  create(data: Prisma.PartnerUncheckedCreateInput): Promise<Partner>;
  update(id: string, data: Prisma.PartnerUpdateInput): Promise<Partner>;
  softDelete(id: string): Promise<Partner>;
}

export class PartnerRepository implements IPartnerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<Partner | null> {
    return this.prisma.partner.findFirst({ where: { id, deletedAt: null } });
  }

  findByExternalId(externalId: string): Promise<Partner | null> {
    return this.prisma.partner.findFirst({ where: { externalId, deletedAt: null } });
  }

  async list(filter: ListPartnersFilter): Promise<Partner[]> {
    const where: Prisma.PartnerWhereInput = { deletedAt: null };
    if (filter.status) where.status = filter.status;
    if (filter.tier) where.tier = filter.tier;
    if (filter.q) {
      where.OR = [
        { name: { contains: filter.q, mode: 'insensitive' } },
        { externalId: { contains: filter.q, mode: 'insensitive' } },
        { industry: { contains: filter.q, mode: 'insensitive' } },
      ];
    }
    if (filter.cursor) {
      where.OR = (where.OR ?? []).concat([
        { createdAt: { lt: filter.cursor.createdAt } },
        { AND: [{ createdAt: filter.cursor.createdAt }, { id: { lt: filter.cursor.id } }] },
      ]);
    }
    return this.prisma.partner.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }

  create(data: Prisma.PartnerUncheckedCreateInput): Promise<Partner> {
    return this.prisma.partner.create({ data });
  }

  update(id: string, data: Prisma.PartnerUpdateInput): Promise<Partner> {
    return this.prisma.partner.update({ where: { id }, data });
  }

  softDelete(id: string): Promise<Partner> {
    return this.prisma.partner.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'CHURNED' },
    });
  }
}
