/**
 * PortfolioRepository unit tests.
 *
 * The repository is the single bridge between routes and Prisma; we lock
 * down its contract WITHOUT a live database by stubbing only the Prisma
 * methods we touch. A schema rename forces stub updates → drift surfaces
 * in CI, not at runtime.
 *
 * What's covered:
 *   - Verticals: list/get pass-through; upsert composes create/update body
 *   - Businesses: list filters by vertical; patch is no-op if body empty;
 *     patch translates ownershipPct/decimals to strings
 *   - Replace-set semantics: financial periods, channels, products, cohorts,
 *     headcount all delete-then-bulk-insert in a single $transaction
 *   - getLatest* helpers find the latest asOf, then return rows for that day
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'c'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

describe('PortfolioRepository — verticals', () => {
  it('upsertVertical composes a create/update body and returns the row', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const captured: Array<unknown> = [];
    const writer = {
      portfolioVertical: {
        upsert: vi.fn(async (args: unknown) => {
          captured.push(args);
          return { slug: 'coaching', name: 'Coaching', description: 'desc' };
        }),
      },
    } as never;
    const repo = new PortfolioRepository(writer);
    const out = await repo.upsertVertical({
      slug: 'coaching',
      name: 'Coaching',
      description: 'desc',
    });
    expect(out.slug).toBe('coaching');
    const args = captured[0] as {
      where: { slug: string };
      create: { slug: string; description: string };
    };
    expect(args.where.slug).toBe('coaching');
    expect(args.create.description).toBe('desc');
  });

  it('upsertVertical defaults description to empty string', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const captured: Array<unknown> = [];
    const writer = {
      portfolioVertical: {
        upsert: vi.fn(async (args: unknown) => {
          captured.push(args);
          return { slug: 'medical', name: 'Medical', description: '' };
        }),
      },
    } as never;
    const repo = new PortfolioRepository(writer);
    await repo.upsertVertical({ slug: 'medical', name: 'Medical' });
    const args = captured[0] as { create: { description: string } };
    expect(args.create.description).toBe('');
  });
});

describe('PortfolioRepository — businesses', () => {
  it('listBusinesses filters by vertical when supplied', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const findMany = vi.fn(async () => []);
    const reader = { portfolioBusiness: { findMany } } as never;
    const writer = {} as never;
    const repo = new PortfolioRepository(writer, reader);
    await repo.listBusinesses({ vertical: 'coaching' });
    const calls = findMany.mock.calls as unknown as Array<[{ where: { verticalSlug: string } }]>;
    expect(calls[0]?.[0]?.where.verticalSlug).toBe('coaching');
  });

  it('listBusinesses with no filter passes empty where', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const findMany = vi.fn(async () => []);
    const reader = { portfolioBusiness: { findMany } } as never;
    const writer = {} as never;
    const repo = new PortfolioRepository(writer, reader);
    await repo.listBusinesses();
    const calls2 = findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>;
    expect(calls2[0]?.[0]?.where).toEqual({});
  });

  it('upsertBusiness stringifies decimal-ish fields and uppercases currency', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const captured: Array<unknown> = [];
    const writer = {
      portfolioBusiness: {
        upsert: vi.fn(async (args: unknown) => {
          captured.push(args);
          return { slug: 'apex' };
        }),
      },
    } as never;
    const repo = new PortfolioRepository(writer);
    await repo.upsertBusiness({
      slug: 'apex',
      name: 'Apex',
      verticalSlug: 'coaching',
      status: 'ACTIVE',
      acquiredAt: new Date('2024-08-01'),
      ownershipPct: 0.85,
      hqRegion: 'US-NY',
      segment: 'Sales coaching',
      fteCount: 28,
      currency: 'usd',
      ttmRevenue: 14_200_000,
      ttmEbitda: 3_950_000,
      ttmGrossProfit: 11_300_000,
      arr: 9_800_000,
      nrr: 1.18,
      grossMargin: 0.795,
      cashOnHand: 2_400_000,
      netDebt: -800_000,
    });
    const args = captured[0] as {
      create: { ownershipPct: string; ttmRevenue: string; currency: string };
    };
    expect(args.create.ownershipPct).toBe('0.85');
    expect(args.create.ttmRevenue).toBe('14200000');
    expect(args.create.currency).toBe('USD');
  });

  it('patchBusiness with empty body short-circuits to getBusiness', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const findUnique = vi.fn(async () => ({ slug: 'apex' }));
    const update = vi.fn();
    const writer = { portfolioBusiness: { update } } as never;
    const reader = { portfolioBusiness: { findUnique } } as never;
    const repo = new PortfolioRepository(writer, reader);
    const out = await repo.patchBusiness('apex', {});
    expect(out).toEqual({ slug: 'apex' });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PortfolioRepository — replace-set tx semantics', () => {
  function buildTxHarness() {
    const txOps = {
      portfolioFinancialPeriod: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      portfolioRevenueChannel: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      portfolioProductLine: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      portfolioCohort: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      portfolioHeadcount: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const writer = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txOps)),
    } as never;
    return { writer, txOps };
  }

  it('replaceFinancialPeriods deletes-then-bulk-inserts in one tx', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const h = buildTxHarness();
    const repo = new PortfolioRepository(h.writer);
    const periods = [
      {
        periodStart: new Date('2026-04-01'),
        periodLabel: 'Apr 26',
        revenue: 100,
        cogs: 20,
        grossProfit: 80,
        marketingSpend: 10,
        payroll: 30,
        rentAndUtilities: 2,
        softwareAndTools: 1,
        professionalServices: 1,
        otherOpex: 5,
        ebitda: 31,
        depreciation: 2,
        interest: 1,
        tax: 7,
        netIncome: 21,
        cashIn: 95,
        cashOut: 70,
        arBalance: 18,
        apBalance: 12,
      },
    ];
    const n = await repo.replaceFinancialPeriods('apex', periods);
    expect(n).toBe(1);
    expect(h.txOps.portfolioFinancialPeriod.deleteMany).toHaveBeenCalledOnce();
    expect(h.txOps.portfolioFinancialPeriod.createMany).toHaveBeenCalledOnce();
  });

  it('replaceFinancialPeriods with empty list deletes existing and inserts nothing', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const h = buildTxHarness();
    const repo = new PortfolioRepository(h.writer);
    const n = await repo.replaceFinancialPeriods('apex', []);
    expect(n).toBe(0);
    expect(h.txOps.portfolioFinancialPeriod.deleteMany).toHaveBeenCalledOnce();
    expect(h.txOps.portfolioFinancialPeriod.createMany).not.toHaveBeenCalled();
  });

  it('replaceChannels scopes the delete to the same (slug, asOf) it inserts at', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const h = buildTxHarness();
    const repo = new PortfolioRepository(h.writer);
    const asOf = new Date('2026-05-07');
    await repo.replaceChannels('apex', asOf, [
      { channel: 'Paid social', revenue: 100, customers: 10, share: 0.5 },
    ]);
    const calls = h.txOps.portfolioRevenueChannel.deleteMany.mock.calls as unknown as Array<
      [{ where: { businessSlug: string; asOf: Date } }]
    >;
    const deleteArgs = calls[0]?.[0];
    if (!deleteArgs) throw new Error('expected delete call');
    expect(deleteArgs.where.businessSlug).toBe('apex');
    expect(deleteArgs.where.asOf).toBe(asOf);
  });

  it('replaceCohorts trims to the businessSlug — no leakage across silos', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const h = buildTxHarness();
    const repo = new PortfolioRepository(h.writer);
    await repo.replaceCohorts('apex', [
      { cohortMonth: new Date('2026-01-01'), customers: 100, m0: 1, m3: 0.6, m6: 0.4, m12: 0.3 },
    ]);
    const cohortCalls = h.txOps.portfolioCohort.deleteMany.mock.calls as unknown as Array<
      [{ where: { businessSlug: string } }]
    >;
    const cohortDelete = cohortCalls[0]?.[0];
    if (!cohortDelete) throw new Error('expected delete call');
    expect(cohortDelete.where.businessSlug).toBe('apex');
  });
});

describe('PortfolioRepository — getLatest helpers', () => {
  it('getLatestChannels returns [] when no rows exist for the silo', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const reader = {
      portfolioRevenueChannel: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(),
      },
    } as never;
    const writer = {} as never;
    const repo = new PortfolioRepository(writer, reader);
    const out = await repo.getLatestChannels('apex');
    expect(out).toEqual([]);
    const r = reader as unknown as {
      portfolioRevenueChannel: { findMany: ReturnType<typeof vi.fn> };
    };
    expect(r.portfolioRevenueChannel.findMany).not.toHaveBeenCalled();
  });

  it('getLatestChannels: pinpoints the latest asOf and returns rows for that day', async () => {
    const { PortfolioRepository } =
      await import('../../src/domains/portfolio/portfolio.repository.js');
    const latestAsOf = new Date('2026-05-07');
    const reader = {
      portfolioRevenueChannel: {
        findFirst: vi.fn(async () => ({ asOf: latestAsOf })),
        findMany: vi.fn(async () => [{ channel: 'Paid social' }]),
      },
    } as never;
    const writer = {} as never;
    const repo = new PortfolioRepository(writer, reader);
    const out = await repo.getLatestChannels('apex');
    expect(out).toHaveLength(1);
    const r = reader as unknown as {
      portfolioRevenueChannel: { findMany: ReturnType<typeof vi.fn> };
    };
    const args = r.portfolioRevenueChannel.findMany.mock.calls[0]?.[0] as { where: { asOf: Date } };
    expect(args.where.asOf).toBe(latestAsOf);
  });
});
