import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { Partner } from '@prisma/client';
import { errors } from '../../shared/errors/app-error.js';
import { paginate, type Paginated } from '../../shared/utils/pagination.js';
import type {
  CreatePartnerInput,
  UpdatePartnerInput,
  ListPartnersQuery,
} from './partner.schemas.js';
import type { IPartnerRepository } from './partner.repository.js';
import { parseCursor } from '../../shared/utils/pagination.js';

export class PartnerService {
  constructor(private readonly repo: IPartnerRepository) {}

  async list(query: ListPartnersQuery): Promise<Paginated<Partner>> {
    const cursor = parseCursor(query.cursor);
    const rows = await this.repo.list({
      status: query.status,
      tier: query.tier,
      q: query.q,
      cursor,
      limit: query.limit,
    });
    return paginate(rows, query.limit);
  }

  async getById(id: string): Promise<Partner> {
    const row = await this.repo.findById(id);
    if (!row) throw errors.notFound('Partner', id);
    return row;
  }

  async create(input: CreatePartnerInput & { orgId: string }): Promise<Partner> {
    const exists = await this.repo.findByExternalId(input.orgId, input.externalId);
    if (exists)
      throw errors.conflict(`Partner with externalId already exists`, {
        externalId: input.externalId,
      });
    const cost = new Prisma.Decimal(input.pixieDataPullCost);
    const charge = new Prisma.Decimal(input.pixieChargeRate);
    const margin = charge.minus(cost);
    return this.repo.create({
      id: uuidv7(),
      // Phase 1 retrofit: Partner is org-scoped; externalId uniqueness is per-org.
      orgId: input.orgId,
      externalId: input.externalId,
      name: input.name,
      industry: input.industry,
      onboardingDate: input.onboardingDate ? new Date(input.onboardingDate) : new Date(),
      tier: input.tier,
      status: 'ACTIVE',
      contractValue: new Prisma.Decimal(input.contractValue),
      buzzpayRevSharePct: new Prisma.Decimal(input.buzzpayRevSharePct),
      pixieDataPullCost: cost,
      pixieChargeRate: charge,
      pixieMargin: margin,
      metadata: input.metadata as Prisma.InputJsonValue,
    });
  }

  async update(id: string, input: UpdatePartnerInput): Promise<Partner> {
    const existing = await this.getById(id);
    const data: Prisma.PartnerUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.industry !== undefined) data.industry = input.industry;
    if (input.tier !== undefined) data.tier = input.tier;
    if (input.status !== undefined) data.status = input.status;
    if (input.contractValue !== undefined)
      data.contractValue = new Prisma.Decimal(input.contractValue);
    if (input.buzzpayRevSharePct !== undefined)
      data.buzzpayRevSharePct = new Prisma.Decimal(input.buzzpayRevSharePct);
    if (input.pixieDataPullCost !== undefined || input.pixieChargeRate !== undefined) {
      const cost = new Prisma.Decimal(input.pixieDataPullCost ?? existing.pixieDataPullCost);
      const charge = new Prisma.Decimal(input.pixieChargeRate ?? existing.pixieChargeRate);
      data.pixieDataPullCost = cost;
      data.pixieChargeRate = charge;
      data.pixieMargin = charge.minus(cost);
    }
    if (input.metadata !== undefined) data.metadata = input.metadata as Prisma.InputJsonValue;
    return this.repo.update(id, data);
  }

  async softDelete(id: string): Promise<Partner> {
    await this.getById(id);
    return this.repo.softDelete(id);
  }
}
