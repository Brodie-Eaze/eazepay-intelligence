/**
 * FX (foreign-exchange) rate service.
 *
 * Looks up the latest FxRate at-or-before a timestamp and converts decimals
 * between currencies. Used by analytics + reporting paths so a USD-funded
 * loan can be summed alongside an AUD-funded loan in a single roll-up.
 *
 * Lookup semantics
 *   - Same currency  → identity (rate = 1)
 *   - Direct rate    → uses `(base, quote)` row at-or-before asOf
 *   - Inverse rate   → if the inverse exists, returns 1/inverse
 *   - Triangulation  → falls back to the platform's REPORTING_CURRENCY as
 *                      a pivot. base→reporting * reporting→quote.
 *   - No rate        → throws. Callers should treat this as a hard error;
 *                      silently dropping the conversion would corrupt
 *                      financial roll-ups.
 *
 * Caching
 *   In-process LRU keyed on `(base, quote, asOfDay)`. FX rates change
 *   daily at most for the use cases here; per-day cache is the right
 *   primitive. Cache TTL = 1 hour. Bypass via `getRate({ noCache: true })`.
 *
 * SOC 2 mapping
 *   - PI1.1 — processing integrity for currency conversion
 *   - CC7.3 — every rate ingestion writes an audit row (FX_RATE_INGESTED)
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { errors } from '../../shared/errors/app-error.js';

interface CacheEntry {
  rate: Prisma.Decimal;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

export class FxService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly reportingCurrency: string,
  ) {}

  /**
   * Convert `amount` from `from` to `to`, anchored at `asOf` (defaults to now).
   * Returns a Prisma.Decimal so caller-side precision is preserved.
   */
  async convert(
    amount: Prisma.Decimal | string | number,
    from: string,
    to: string,
    asOf?: Date,
  ): Promise<Prisma.Decimal> {
    const dec = amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
    if (from === to) return dec;
    const rate = await this.getRate(from, to, asOf);
    return dec.mul(rate);
  }

  /**
   * Get the rate from `from` to `to` at-or-before `asOf`. Throws if no
   * direct, inverse, or triangulated path is available.
   */
  async getRate(
    from: string,
    to: string,
    asOf?: Date,
    opts?: { noCache?: boolean },
  ): Promise<Prisma.Decimal> {
    if (from === to) return new Prisma.Decimal(1);

    const ts = asOf ?? new Date();
    const day = ts.toISOString().slice(0, 10);
    const cacheKey = `${from}>${to}@${day}`;
    if (!opts?.noCache) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.rate;
    }

    // Direct rate.
    const direct = await this.lookupDirect(from, to, ts);
    if (direct) {
      this.cacheSet(cacheKey, direct);
      return direct;
    }

    // Inverse rate.
    const inverse = await this.lookupDirect(to, from, ts);
    if (inverse) {
      const rate = new Prisma.Decimal(1).div(inverse);
      this.cacheSet(cacheKey, rate);
      return rate;
    }

    // Triangulate via reporting currency.
    if (from !== this.reportingCurrency && to !== this.reportingCurrency) {
      const fromToReporting = await this.lookupAny(from, this.reportingCurrency, ts);
      const reportingToQuote = await this.lookupAny(this.reportingCurrency, to, ts);
      if (fromToReporting && reportingToQuote) {
        const rate = fromToReporting.mul(reportingToQuote);
        this.cacheSet(cacheKey, rate);
        return rate;
      }
    }

    throw errors.badRequest(
      `No FX rate available: ${from}→${to} as of ${ts.toISOString().slice(0, 10)}`,
    );
  }

  /** Direct rate or inverse, whichever is present. Used inside triangulation. */
  private async lookupAny(from: string, to: string, ts: Date): Promise<Prisma.Decimal | null> {
    if (from === to) return new Prisma.Decimal(1);
    const direct = await this.lookupDirect(from, to, ts);
    if (direct) return direct;
    const inverse = await this.lookupDirect(to, from, ts);
    if (inverse) return new Prisma.Decimal(1).div(inverse);
    return null;
  }

  private async lookupDirect(from: string, to: string, ts: Date): Promise<Prisma.Decimal | null> {
    const row = await this.prisma.fxRate.findFirst({
      where: {
        baseCurrency: from,
        quoteCurrency: to,
        asOf: { lte: ts },
      },
      orderBy: { asOf: 'desc' },
      select: { rate: true },
    });
    return row?.rate ?? null;
  }

  private cacheSet(key: string, rate: Prisma.Decimal): void {
    // Bound the cache so a misbehaving caller can't OOM the process.
    if (this.cache.size > 5_000) this.cache.clear();
    this.cache.set(key, { rate, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  /** Test-only: clear the cache to avoid cross-test contamination. */
  __clearCacheForTests(): void {
    this.cache.clear();
  }
}
