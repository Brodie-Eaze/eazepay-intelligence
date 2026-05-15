'use client';

/**
 * BusinessKpiPanel — shared shell for the three new per-business KPI
 * dashboards (Aurean AI, Aurean Recruitment, HighSale).
 *
 * Each dashboard supplies:
 *   - Page title + subtitle
 *   - API endpoint path under /api/v1
 *   - A list of `KpiCard`s to render from the response payload
 *
 * Keeps the route files tiny (one config object each) instead of three
 * near-identical 80-LOC dashboards.
 */
import { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface KpiCardSpec<T> {
  label: string;
  pick: (data: T) => string | number | undefined | null;
  /** Optional formatter (default: identity). */
  format?: (v: string | number) => string;
}

interface Props<T extends object> {
  title: string;
  subtitle?: string;
  endpoint: string;
  cards: Array<KpiCardSpec<T>>;
  emptyHint?: ReactNode;
}

export function BusinessKpiPanel<T extends object>({
  title,
  subtitle,
  endpoint,
  cards,
  emptyHint,
}: Props<T>): JSX.Element {
  const q = useQuery({
    queryKey: ['kpis', endpoint],
    queryFn: () => api<T>(endpoint),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader title={title} subtitle={subtitle} />
      <SectionCard title="Last 7–30 day window">
        {q.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : q.isError ? (
          <p className="text-sm text-red-600">Failed to load KPIs.</p>
        ) : !q.data ? (
          <p className="text-sm text-zinc-500">No data.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {cards.map((c) => {
              const data = q.data as T;
              const raw = c.pick(data);
              const display =
                raw == null ? '—' : c.format ? c.format(raw as string | number) : String(raw);
              return <KpiCard key={c.label} label={c.label} value={display} />;
            })}
          </div>
        )}
      </SectionCard>
      {emptyHint && q.data && Object.keys(q.data).length === 0 && (
        <p className="text-xs text-zinc-500">{emptyHint}</p>
      )}
    </div>
  );
}
