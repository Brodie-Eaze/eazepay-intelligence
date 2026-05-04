import { Prisma } from '@prisma/client';
import type { ILenderRepository } from './lender.repository.js';
import type { LenderRangeQuery, WaterfallRow } from './lender.schemas.js';

export class LenderService {
  constructor(private readonly repo: ILenderRepository) {}

  async waterfall(query: LenderRangeQuery): Promise<WaterfallRow[]> {
    const rows = await this.repo.waterfall({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      tier: query.tier,
    });
    return rows.map((r) => {
      const submitted = r.submitted || 0;
      const approved = r.approved;
      const approvalRate = submitted === 0 ? '0' : new Prisma.Decimal(approved).div(submitted).toFixed(4);
      const fundingRate = approved === 0 ? '0' : new Prisma.Decimal(r.funded).div(approved).toFixed(4);
      return {
        lenderName: r.lenderName,
        lenderTier: r.lenderTier,
        submitted,
        approved,
        declined: r.declined,
        funded: r.funded,
        approvalRate,
        fundingRate,
        avgApr: r.avgApr,
        totalFunded: r.totalFunded,
      };
    });
  }
}
