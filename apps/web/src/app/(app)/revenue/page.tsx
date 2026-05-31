'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { RevenueByStreamRow } from '@/lib/types';
import { RevenueAreaChart } from '@/components/RevenueAreaChart';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar, type FilterDef } from '@/components/ui/FilterBar';
import { getLabel, listOptions } from '@/lib/taxonomy';

interface Range {
  label: string;
  value: string;
  days: number;
  bucket: 'day' | 'week' | 'month';
}

const RANGES: Range[] = [
  { label: '7d', value: '7d', days: 7, bucket: 'day' },
  { label: '30d', value: '30d', days: 30, bucket: 'day' },
  { label: '90d', value: '90d', days: 90, bucket: 'day' },
  { label: 'YTD', value: 'ytd', days: 365, bucket: 'week' },
  { label: 'All', value: 'all', days: 730, bucket: 'month' },
];

const FILTERS: FilterDef[] = [
  {
    key: 'range',
    label: 'Range',
    type: 'select',
    options: RANGES.map((r) => ({ value: r.value, label: r.label })),
  },
  {
    key: 'stream',
    label: 'Stream',
    type: 'select',
    options: listOptions('revenueStream'),
  },
];

export default function RevenuePage(): JSX.Element {
  const params = useSearchParams();
  const rangeValue = params.get('range') ?? '90d';
  const stream = params.get('stream') ?? '';
  const range = RANGES.find((r) => r.value === rangeValue) ?? RANGES[2]!;

  const q = useQuery({
    queryKey: ['analytics.revenue', range.value],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - range.days * 86_400_000).toISOString();
      return api<RevenueByStreamRow[]>(
        `/analytics/revenue?from=${from}&to=${to}&bucket=${range.bucket}`,
      );
    },
  });

  const data = (q.data ?? []).filter((row) => (stream ? row.stream === stream : true));

  const totals = data.reduce<Record<string, number>>((acc, row) => {
    acc[row.stream] = (acc[row.stream] ?? 0) + Number(row.amount);
    return acc;
  }, {});
  const grand = Object.values(totals).reduce((s, n) => s + n, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue"
        subtitle="Stream breakdown · projected from append-only commission ledger"
        action={<FilterBar filters={FILTERS} />}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Total revenue" value={formatMoney(grand)} hint={`${range.label} window`} />
        <KpiCard
          label={`${getLabel('revenueStream', 'PIXIE')} margin`}
          value={formatMoney(totals.PIXIE ?? 0)}
          hint={`${pct(totals.PIXIE, grand)} of total`}
        />
        <KpiCard
          label={`${getLabel('revenueStream', 'MICAMP')} processing`}
          value={formatMoney(totals.MICAMP ?? 0)}
          hint={`${pct(totals.MICAMP, grand)} of total · 50/50 split`}
        />
      </div>

      <SectionCard
        title="Revenue trajectory"
        subtitle={`bucket: ${range.bucket}${stream ? ` · ${getLabel('revenueStream', stream)} only` : ''}`}
        bodyClassName="p-3"
      >
        {q.data ? (
          <RevenueAreaChart data={data} height={360} />
        ) : (
          <div className="text-muted p-6">Loading…</div>
        )}
      </SectionCard>
    </div>
  );
}

function pct(part: number | undefined, whole: number): string {
  if (!whole || !part) return '0%';
  return `${((part / whole) * 100).toFixed(0)}%`;
}
