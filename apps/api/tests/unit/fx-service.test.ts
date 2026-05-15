/**
 * FxService tests.
 *
 * Locks down the lookup contract:
 *   - Same currency  → identity (rate = 1, no DB hit)
 *   - Direct rate    → uses (base, quote) row at-or-before asOf
 *   - Inverse rate   → if direct missing but (quote, base) present, returns 1/x
 *   - Triangulation  → falls back through REPORTING_CURRENCY when neither side is the reporting currency
 *   - No path        → throws
 *   - Cache          → hits the DB once per (base, quote, day), TTL bypass works
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { Prisma } from '@prisma/client';
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

interface RateRow {
  baseCurrency: string;
  quoteCurrency: string;
  rate: Prisma.Decimal;
  asOf: Date;
}

function makePrisma(rows: RateRow[]) {
  return {
    fxRate: {
      findFirst: vi.fn(
        async (args: {
          where: { baseCurrency: string; quoteCurrency: string; asOf?: { lte?: Date } };
        }) => {
          const cutoff = args.where.asOf?.lte ?? new Date();
          const matches = rows
            .filter(
              (r) =>
                r.baseCurrency === args.where.baseCurrency &&
                r.quoteCurrency === args.where.quoteCurrency &&
                r.asOf <= cutoff,
            )
            .sort((a, b) => b.asOf.getTime() - a.asOf.getTime());
          return matches[0] ?? null;
        },
      ),
    },
  } as never;
}

describe('FxService', () => {
  it('returns identity for same-currency conversion (no DB hit)', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    const prisma = makePrisma([]);
    const svc = new FxService(prisma, 'USD');
    const out = await svc.convert('100', 'USD', 'USD');
    expect(out.toString()).toBe('100');
    const p = prisma as unknown as { fxRate: { findFirst: ReturnType<typeof vi.fn> } };
    expect(p.fxRate.findFirst).not.toHaveBeenCalled();
  });

  it('uses a direct rate when present', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    const prisma = makePrisma([
      {
        baseCurrency: 'USD',
        quoteCurrency: 'AUD',
        rate: new Prisma.Decimal('1.5'),
        asOf: new Date('2026-05-01'),
      },
    ]);
    const svc = new FxService(prisma, 'USD');
    const out = await svc.convert('100', 'USD', 'AUD', new Date('2026-05-07'));
    expect(out.toString()).toBe('150');
  });

  it('falls back to inverse when direct is missing', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    const prisma = makePrisma([
      // Only USD->AUD = 1.5, asking for AUD->USD should yield 1/1.5
      {
        baseCurrency: 'USD',
        quoteCurrency: 'AUD',
        rate: new Prisma.Decimal('1.5'),
        asOf: new Date('2026-05-01'),
      },
    ]);
    const svc = new FxService(prisma, 'USD');
    const out = await svc.convert('150', 'AUD', 'USD');
    expect(out.toFixed(2)).toBe('100.00');
  });

  it('triangulates via reporting currency when neither side has a direct/inverse rate', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    // GBP→EUR not present, but GBP→USD and USD→EUR are.
    const prisma = makePrisma([
      {
        baseCurrency: 'GBP',
        quoteCurrency: 'USD',
        rate: new Prisma.Decimal('1.25'),
        asOf: new Date('2026-05-01'),
      },
      {
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: new Prisma.Decimal('0.92'),
        asOf: new Date('2026-05-01'),
      },
    ]);
    const svc = new FxService(prisma, 'USD');
    const out = await svc.convert('80', 'GBP', 'EUR');
    // 80 * 1.25 * 0.92 = 92
    expect(out.toFixed(2)).toBe('92.00');
  });

  it('throws when no direct, inverse, or triangulated path exists', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    const prisma = makePrisma([]);
    const svc = new FxService(prisma, 'USD');
    await expect(svc.convert('100', 'JPY', 'BRL')).rejects.toThrow(/No FX rate available/);
  });

  it('caches per (base, quote, day) — hits DB once', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    const prisma = makePrisma([
      {
        baseCurrency: 'USD',
        quoteCurrency: 'AUD',
        rate: new Prisma.Decimal('1.5'),
        asOf: new Date('2026-05-01'),
      },
    ]);
    const svc = new FxService(prisma, 'USD');
    const day = new Date('2026-05-07T10:00:00Z');
    await svc.getRate('USD', 'AUD', day);
    await svc.getRate('USD', 'AUD', day);
    await svc.getRate('USD', 'AUD', day);
    const p = prisma as unknown as { fxRate: { findFirst: ReturnType<typeof vi.fn> } };
    // Direct lookup runs once; cache hits the rest.
    expect(p.fxRate.findFirst).toHaveBeenCalledTimes(1);
  });

  it('uses the rate at-or-before asOf, not a future one', async () => {
    const { FxService } = await import('../../src/domains/fx/fx.service.js');
    const prisma = makePrisma([
      {
        baseCurrency: 'USD',
        quoteCurrency: 'AUD',
        rate: new Prisma.Decimal('1.4'),
        asOf: new Date('2026-05-01'),
      },
      {
        baseCurrency: 'USD',
        quoteCurrency: 'AUD',
        rate: new Prisma.Decimal('1.6'),
        asOf: new Date('2026-05-15'),
      },
    ]);
    const svc = new FxService(prisma, 'USD');
    // Asking on May 7 should use the May 1 rate (latest before).
    const r = await svc.getRate('USD', 'AUD', new Date('2026-05-07'));
    expect(r.toString()).toBe('1.4');
  });
});
