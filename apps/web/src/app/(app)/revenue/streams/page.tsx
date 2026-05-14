'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';
import { RevenueAreaChart } from '@/components/RevenueAreaChart';
import type { RevenueByStreamRow } from '@/lib/types';

export default function StreamBreakdownPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['revenue.streams'],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
      return api<RevenueByStreamRow[]>(`/analytics/revenue?from=${from}&to=${to}&bucket=day`);
    },
  });

  const data = q.data ?? [];
  const totals = data.reduce<Record<string, number>>((a, r) => {
    a[r.stream] = (a[r.stream] ?? 0) + Number(r.amount);
    return a;
  }, {});
  const grand = Object.values(totals).reduce((s, n) => s + n, 0);
  const max = Math.max(1, ...Object.values(totals));

  const STREAMS: Array<{
    key: 'PIXIE' | 'MICAMP';
    label: string;
    sub: string;
    href: string;
    tone: 'accent' | 'success' | 'warn';
  }> = [
    { key: 'PIXIE', label: 'Pixie', sub: 'HighSale margin', href: '/pixie', tone: 'success' },
    { key: 'MICAMP', label: 'MiCamp', sub: 'Processing 50/50', href: '/micamp', tone: 'warn' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stream breakdown"
        subtitle="Active streams · 90 days · click a card to drill in"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {STREAMS.map((s) => (
          <Link key={s.key} href={s.href} className="block hover:scale-[1.01] transition">
            <KpiCard
              label={`${s.label} · ${s.sub}`}
              value={formatMoney(totals[s.key] ?? 0)}
              hint={`${formatPct(grand ? (totals[s.key] ?? 0) / grand : 0)} of total`}
            />
          </Link>
        ))}
      </div>

      <SectionCard title="Stack over time" subtitle="last 90 days" bodyClassName="p-3">
        <RevenueAreaChart data={data} height={360} />
      </SectionCard>

      <SectionCard title="Stream contribution" subtitle="relative share over the same window">
        <div className="space-y-4">
          {STREAMS.map((s) => (
            <div key={s.key}>
              <div className="flex items-center justify-between mb-1.5 text-sm">
                <Link href={s.href} className="text-ink hover:text-accent font-medium">
                  {s.label}
                </Link>
                <span className="numeric text-ink2">
                  {formatMoney(totals[s.key] ?? 0)}{' '}
                  <span className="text-muted">
                    · {formatPct(grand ? (totals[s.key] ?? 0) / grand : 0)}
                  </span>
                </span>
              </div>
              <MiniBar value={(totals[s.key] ?? 0) / max} tone={s.tone} className="h-2.5" />
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
