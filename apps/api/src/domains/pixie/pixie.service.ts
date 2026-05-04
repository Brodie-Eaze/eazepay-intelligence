import type { IPixieRepository } from './pixie.repository.js';
import type { PixieUsageQuery } from './pixie.schemas.js';
import { getEnv } from '../../config/env.js';

export class PixieService {
  constructor(private readonly repo: IPixieRepository) {}

  async usage(query: PixieUsageQuery): Promise<unknown[]> {
    const rows = await this.repo.list({
      partnerId: query.partnerId,
      period: query.period,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return rows.map((r) => ({
      partnerId: r.partnerId,
      period: r.period,
      periodStart: r.periodStart.toISOString(),
      periodEnd: r.periodEnd.toISOString(),
      pulls: r.dataPullsThisPeriod,
      cumulative: r.dataPullsCumulative,
      costPerPull: r.costPerPull.toString(),
      chargePerPull: r.chargePerPull.toString(),
      profitPerPull: r.profitPerPull.toString(),
      totalRevenue: r.totalRevenue.toString(),
      volumeThreshold: r.volumeThreshold,
      volumeAchieved: r.volumeAchieved,
    }));
  }

  async breakpointStatus(): Promise<{ collectiveLast24h: number; threshold: number; aboveBreakpoint: boolean }> {
    const env = getEnv();
    const r = await this.repo.collectiveLast24h();
    return {
      collectiveLast24h: r.pulls,
      threshold: env.PIXIE_VOLUME_BREAKPOINT,
      aboveBreakpoint: r.pulls >= env.PIXIE_VOLUME_BREAKPOINT,
    };
  }
}
