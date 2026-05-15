import { describe, expect, it } from 'vitest';
import { formatDelta, formatMoney, formatNumber, formatPct } from './format';

/**
 * Smoke coverage for the formatters in `lib/format.ts`. These are the
 * only pure utility functions in apps/web today and they ship to every
 * page that displays a money / percentage / count value — a regression
 * here corrupts almost every screen at once.
 *
 * Locale-sensitive output is asserted by *structure* (e.g. "starts with
 * a currency symbol", "ends with %") rather than exact bytes so the
 * suite doesn't break when NEXT_PUBLIC_REPORTING_LOCALE flips between
 * `en-US` and `en-AU` between environments.
 */
describe('formatMoney', () => {
  it('renders a whole-dollar amount with no fractional digits by default', () => {
    const out = formatMoney(1234);
    // "US$1,234" / "$1,234" / "$1,234.00" — accept either form, just no decimals
    expect(out).toMatch(/1,234(?!\.)/);
  });

  it('renders cents when precise: true is passed', () => {
    const out = formatMoney(1234.56, { precise: true });
    expect(out).toMatch(/1,234\.56/);
  });

  it('accepts a numeric string (Decimal serialisation path)', () => {
    expect(formatMoney('42')).toMatch(/42/);
  });

  it('returns em-dash for non-finite inputs', () => {
    expect(formatMoney('not-a-number')).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatPct', () => {
  it('multiplies by 100 and appends %', () => {
    expect(formatPct(0.1234)).toBe('12.3%');
  });

  it('honours fractionDigits override', () => {
    expect(formatPct(0.1, 0)).toBe('10%');
    expect(formatPct(0.123456, 3)).toBe('12.346%');
  });

  it('returns em-dash for non-finite inputs', () => {
    expect(formatPct(Number.NaN)).toBe('—');
  });
});

describe('formatDelta', () => {
  it('tags positives as up with a + prefix', () => {
    const d = formatDelta(0.05);
    expect(d.tone).toBe('up');
    expect(d.text.startsWith('+')).toBe(true);
  });

  it('tags negatives as down without an extra prefix', () => {
    const d = formatDelta(-0.05);
    expect(d.tone).toBe('down');
    expect(d.text.startsWith('-')).toBe(true);
  });

  it('returns flat tone with 0% for zero or non-finite', () => {
    expect(formatDelta(0)).toEqual({ text: '0%', tone: 'flat' });
    expect(formatDelta(Number.NaN)).toEqual({ text: '0%', tone: 'flat' });
  });
});

describe('formatNumber', () => {
  it('inserts thousands separators', () => {
    expect(formatNumber(1234567)).toMatch(/1,234,567/);
  });

  it('coerces numeric strings', () => {
    expect(formatNumber('1000')).toMatch(/1,000/);
  });

  it('returns em-dash for non-finite', () => {
    expect(formatNumber('—not-a-number')).toBe('—');
  });
});
