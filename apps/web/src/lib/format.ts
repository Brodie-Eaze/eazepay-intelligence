/** Money + percentage + delta formatters. Money never crosses a JS Number boundary. */

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

const AUD_FRACTION = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: string | number, opts?: { precise?: boolean }): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return (opts?.precise ? AUD_FRACTION : AUD).format(n);
}

export function formatPct(value: string | number, fractionDigits = 1): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(fractionDigits)}%`;
}

export function formatDelta(value: string | number): { text: string; tone: 'up' | 'down' | 'flat' } {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return { text: '0%', tone: 'flat' };
  const sign = n > 0 ? '+' : '';
  return { text: `${sign}${(n * 100).toFixed(1)}%`, tone: n > 0 ? 'up' : 'down' };
}

export function formatNumber(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-AU');
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
