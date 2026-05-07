/** Money + percentage + delta formatters. Money never crosses a JS Number boundary. */

// Reporting currency for the platform — see api `REPORTING_CURRENCY` env.
// USD is the default; cross-region deployments override via NEXT_PUBLIC_*.
const REPORTING_CURRENCY =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_REPORTING_CURRENCY) || 'USD';
const REPORTING_LOCALE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_REPORTING_LOCALE) || 'en-US';

const MONEY = new Intl.NumberFormat(REPORTING_LOCALE, {
  style: 'currency',
  currency: REPORTING_CURRENCY,
  maximumFractionDigits: 0,
});

const MONEY_FRACTION = new Intl.NumberFormat(REPORTING_LOCALE, {
  style: 'currency',
  currency: REPORTING_CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: string | number, opts?: { precise?: boolean }): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return (opts?.precise ? MONEY_FRACTION : MONEY).format(n);
}

export function formatPct(value: string | number, fractionDigits = 1): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(fractionDigits)}%`;
}

export function formatDelta(value: string | number): {
  text: string;
  tone: 'up' | 'down' | 'flat';
} {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return { text: '0%', tone: 'flat' };
  const sign = n > 0 ? '+' : '';
  return { text: `${sign}${(n * 100).toFixed(1)}%`, tone: n > 0 ? 'up' : 'down' };
}

export function formatNumber(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(REPORTING_LOCALE);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(REPORTING_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(REPORTING_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
