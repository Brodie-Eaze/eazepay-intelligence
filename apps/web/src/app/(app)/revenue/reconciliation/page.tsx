'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface Recon {
  months: Array<{
    month: string;
    ledgerTotal: string;
    rollupTotal: string;
    drift: string;
    drifted: boolean;
  }>;
  summary: { monthsTracked: number; driftedMonths: number; allClean: boolean };
  generatedAt: string;
}

export default function ReconciliationPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['admin.reconciliation'],
    queryFn: () => api<Recon>('/admin/reconciliation'),
    refetchInterval: 30_000,
  });

  if (q.isLoading || !q.data) return <div className="text-muted">Loading…</div>;

  const { months, summary, generatedAt } = q.data;
  const totalLedger = months.reduce((s, m) => s + Number(m.ledgerTotal), 0);
  const totalRollup = months.reduce((s, m) => s + Number(m.rollupTotal), 0);
  const totalDrift = totalRollup - totalLedger;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        subtitle="Aggregation rollup vs append-only ledger SUM · clean books = no drift"
        action={
          <span className="text-[11px] text-muted">last refresh {formatDateTime(generatedAt)}</span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Books status"
          value={summary.allClean ? 'Clean' : `${summary.driftedMonths} drift`}
          hint={summary.allClean ? 'every month matches' : 'investigate drifted months'}
        />
        <KpiCard
          label="Ledger total"
          value={formatMoney(totalLedger)}
          hint={`${summary.monthsTracked} months`}
        />
        <KpiCard
          label="Rollup total"
          value={formatMoney(totalRollup)}
          hint="aggregation worker output"
        />
        <KpiCard
          label="Total drift"
          value={Math.abs(totalDrift) < 0.005 ? '$0.00' : formatMoney(totalDrift)}
          hint="rollup − ledger"
        />
      </div>

      <SectionCard
        title="Monthly diff"
        subtitle="any non-zero drift means the aggregation worker fell behind or the ledger has rows the worker hasn't picked up yet"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Month</th>
                <th className="text-right">Ledger SUM</th>
                <th className="text-right">Rollup total</th>
                <th className="text-right">Drift</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td className="numeric text-ink2">
                    {new Date(m.month).toLocaleDateString('en-AU', {
                      year: 'numeric',
                      month: 'long',
                    })}
                  </td>
                  <td className="numeric text-right text-ink">{formatMoney(m.ledgerTotal)}</td>
                  <td className="numeric text-right text-ink">{formatMoney(m.rollupTotal)}</td>
                  <td
                    className={`numeric text-right font-medium ${m.drifted ? 'text-warn' : 'text-muted'}`}
                  >
                    {Math.abs(Number(m.drift)) < 0.005
                      ? '$0.00'
                      : `${Number(m.drift) > 0 ? '+' : ''}${formatMoney(m.drift)}`}
                  </td>
                  <td>
                    {m.drifted ? (
                      <span className="pill pill-warn">Drift</span>
                    ) : (
                      <span className="pill pill-success">Clean</span>
                    )}
                  </td>
                </tr>
              ))}
              {months.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted py-8 text-center">
                    No data yet — run the aggregation worker.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="How this works" bodyClassName="p-5">
        <div className="text-sm text-ink2 leading-relaxed space-y-2">
          <p>
            The <span className="tag">revenue_events</span> ledger is the source of truth — every
            dollar movement is appended on webhook ingestion.
          </p>
          <p>
            The <span className="tag">revenue_aggregations</span> table is rolled up by{' '}
            <span className="tag">workers/aggregation.worker.ts</span>. This page sums both and
            surfaces the diff per month.
          </p>
          <p>
            Drift &gt; $0.005 means either: (1) the worker hasn&apos;t run since the most recent
            ingest, or (2) something has bypassed the ledger. Either way it gets investigated.
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
