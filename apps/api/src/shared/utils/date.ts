import { AggregationPeriod } from '@prisma/client';

/**
 * UTC-only date math. Display tz conversion happens at the response boundary.
 * Dates passed in MUST already be UTC-anchored (ISO with Z, or Date object from
 * Postgres timestamptz, which Prisma always returns as UTC).
 */

const DAY_MS = 86_400_000;

export function startOfUtcDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

export function endOfUtcDay(d: Date): Date {
  const out = startOfUtcDay(d);
  out.setUTCDate(out.getUTCDate() + 1);
  out.setUTCMilliseconds(out.getUTCMilliseconds() - 1);
  return out;
}

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function endOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1);
}

export function startOfUtcYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

export function endOfUtcYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1) - 1);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function periodBoundaries(period: AggregationPeriod, anchor: Date): { start: Date; end: Date } {
  switch (period) {
    case AggregationPeriod.DAILY:
      return { start: startOfUtcDay(anchor), end: endOfUtcDay(anchor) };
    case AggregationPeriod.MONTHLY:
      return { start: startOfUtcMonth(anchor), end: endOfUtcMonth(anchor) };
    case AggregationPeriod.YEARLY:
      return { start: startOfUtcYear(anchor), end: endOfUtcYear(anchor) };
  }
}

export function clampDateRange(from: Date, to: Date, maxDays: number): { from: Date; to: Date } {
  if (to.getTime() < from.getTime()) {
    throw new Error('clampDateRange: `to` precedes `from`');
  }
  const span = (to.getTime() - from.getTime()) / DAY_MS;
  if (span > maxDays) {
    return { from: addDays(to, -maxDays), to };
  }
  return { from, to };
}

export function isoDate(d: Date): string {
  return d.toISOString();
}
