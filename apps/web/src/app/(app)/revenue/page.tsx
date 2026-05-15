'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { RevenueByStreamRow } from '@/lib/types';
import { RevenueAreaChart } from '@/components/RevenueAreaChart';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { PageHeader } from '@/components/PageHeader';

const RANGES: Array<{ label: string; days: number; bucket: 'day' | 'week' | 'month' }> = [
  { label: '7d', days: 7, bucket: 'day' },
  { label: '30d', days: 30, bucket: 'day' },
  { label: '90d', days: 90, bucket: 'day' },
  { label: 'YTD', days: 365, bucket: 'week' },
  { label: 'All', days: 730, bucket: 'month' },
];

export default function RevenuePage(): JSX.Element {
  const [range, setRange] = useState(RANGES[2]!);

  const q = useQuery({
    queryKey: ['analytics.revenue', range.label],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - range.days * 86_400_000).toISOString();
      return api<RevenueByStreamRow[]>(
        `/analytics/revenue?from=${from}&to=${to}&bucket=${range.bucket}`,
      );
    },
  });

  const totals = (q.data ?? []).reduce<Record<string, number>>((acc, row) => {
    acc[row.stream] = (acc[row.stream] ?? 0) + Number(row.amount);
    return acc;
  }, {});
  const grand = Object.values(totals).reduce((s, n) => s + n, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue"
        subtitle="Stream breakdown · projected from append-only commission ledger"
        action={
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-xs rounded-md border ${range.label === r.label ? 'border-accent text-accent bg-accentSoft' : 'border-line text-ink2 hover:bg-surface'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Total revenue" value={formatMoney(grand)} hint={`${range.label} window`} />
        <KpiCard
          label="Pixie margin"
          value={formatMoney(totals.PIXIE ?? 0)}
          hint={`${pct(totals.PIXIE, grand)} of total`}
        />
        <KpiCard
          label="MiCamp processing"
          value={formatMoney(totals.MICAMP ?? 0)}
          hint={`${pct(totals.MICAMP, grand)} of total · 50/50 split`}
        />
      </div>

      <SectionCard
        title="Revenue trajectory"
        subtitle={`bucket: ${range.bucket}`}
        bodyClassName="p-3"
      >
        {q.data ? (
          <RevenueAreaChart data={q.data} height={360} />
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
