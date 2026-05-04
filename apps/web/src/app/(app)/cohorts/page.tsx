'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';

interface CohortRow {
  cohortMonth: string;
  monthsSinceOnboard: number;
  partnerCount: number;
  retainedCount: number;
  revenue: string;
}

export default function CohortsPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.cohorts'],
    queryFn: () => api<CohortRow[]>('/analytics/cohorts'),
  });

  const grid = useMemo(() => {
    const cohorts = new Map<string, Map<number, CohortRow>>();
    for (const r of q.data ?? []) {
      if (!cohorts.has(r.cohortMonth)) cohorts.set(r.cohortMonth, new Map());
      cohorts.get(r.cohortMonth)!.set(r.monthsSinceOnboard, r);
    }
    return cohorts;
  }, [q.data]);

  const months = Array.from(new Set((q.data ?? []).map((r) => r.monthsSinceOnboard))).sort((a, b) => a - b).slice(0, 18);
  const cohortKeys = Array.from(grid.keys()).sort();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cohorts"
        subtitle="Partner retention by onboarding month · darker cells = higher retention"
      />

      <SectionCard title="Retention heatmap" subtitle={`${cohortKeys.length} cohorts × ${months.length} months tracked`} bodyClassName="p-3">
        <div className="overflow-x-auto">
          <table className="text-xs numeric">
            <thead>
              <tr className="text-muted">
                <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider">Cohort</th>
                <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wider">Size</th>
                {months.map((m) => (
                  <th key={m} className="px-2 py-2 text-right text-[11px] uppercase tracking-wider">M+{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohortKeys.map((c) => {
                const m0 = grid.get(c)?.get(0);
                const size = m0?.partnerCount ?? 0;
                return (
                  <tr key={c} className="text-ink2">
                    <td className="px-3 py-1.5 text-left">{c}</td>
                    <td className="px-3 py-1.5 text-right text-ink">{size}</td>
                    {months.map((m) => {
                      const cell = grid.get(c)?.get(m);
                      const pct = cell && cell.partnerCount > 0 ? cell.retainedCount / cell.partnerCount : 0;
                      const opacity = cell ? Math.min(0.95, 0.08 + pct * 0.85) : 0;
                      return (
                        <td
                          key={m}
                          className="px-2 py-1.5 text-right rounded"
                          style={{ background: cell ? `rgba(59, 130, 246, ${opacity.toFixed(2)})` : 'transparent', color: opacity > 0.45 ? '#fff' : undefined }}
                        >
                          {cell ? `${(pct * 100).toFixed(0)}%` : ''}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {cohortKeys.length === 0 && (
                <tr><td colSpan={months.length + 2} className="text-muted py-8 text-center">No cohort data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
