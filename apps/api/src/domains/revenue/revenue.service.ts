import type { RevenueEvent } from '@prisma/client';
import { paginate, parseCursor, type Paginated } from '../../shared/utils/pagination.js';
import type { IRevenueRepository } from './revenue.repository.js';
import type { RevenueByStreamQuery, RevenueLedgerQuery } from './revenue.schemas.js';

export class RevenueService {
  constructor(private readonly repo: IRevenueRepository) {}

  async ledger(orgId: string, query: RevenueLedgerQuery): Promise<Paginated<RevenueEvent>> {
    let cursor: { effectiveAt: Date; idempotencyKey: string } | undefined;
    if (query.cursor) {
      const decoded = parseCursor(query.cursor);
      if (decoded) cursor = { effectiveAt: decoded.createdAt, idempotencyKey: decoded.id };
    }
    const rows = await this.repo.list({
      orgId,
      partnerId: query.partnerId,
      stream: query.stream,
      eventType: query.eventType,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor,
      limit: query.limit,
    });
    // Map shape to satisfy paginate; use effectiveAt as createdAt and idempotencyKey as id.
    const projected = rows.map((r) => ({ ...r, createdAt: r.effectiveAt, id: r.idempotencyKey }));
    return paginate(projected, query.limit);
  }

  byStream(
    orgId: string,
    query: RevenueByStreamQuery,
  ): Promise<Awaited<ReturnType<IRevenueRepository['sumByStream']>>> {
    return this.repo.sumByStream({
      orgId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      bucket: query.bucket,
    });
  }

  byPartner(
    orgId: string,
    args: { from?: string; to?: string; limit?: number },
  ): Promise<Awaited<ReturnType<IRevenueRepository['topPartners']>>> {
    return this.repo.topPartners({
      orgId,
      from: args.from ? new Date(args.from) : undefined,
      to: args.to ? new Date(args.to) : undefined,
      limit: args.limit ?? 10,
    });
  }

  total(orgId: string, args: { from?: string; to?: string; partnerId?: string }): Promise<string> {
    return this.repo.total({
      orgId,
      from: args.from ? new Date(args.from) : undefined,
      to: args.to ? new Date(args.to) : undefined,
      partnerId: args.partnerId,
    });
  }

  clawbacks(orgId: string, args: { from?: string; to?: string }): Promise<RevenueEvent[]> {
    return this.repo.clawbacks({
      orgId,
      from: args.from ? new Date(args.from) : undefined,
      to: args.to ? new Date(args.to) : undefined,
    });
  }
}
