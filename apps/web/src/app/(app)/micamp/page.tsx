'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { ExportButton } from '@/components/ExportButton';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface LedgerRow {
  idempotencyKey: string;
  partnerId: string;
  source: string;
  stream: string;
  eventType: string;
  amount: string;
  effectiveAt: string;
  metadata: { txnCount?: number; gross?: string; reason?: string };
}

export default function MiCampPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['micamp.events'],
    queryFn: () => api<{ data: LedgerRow[] }>('/revenue/ledger?stream=MICAMP&limit=200'),
  });

  const rows = q.data?.data ?? [];
  const fees = rows.filter((r) => r.eventType === 'PROCESSING_FEE');
  const reversals = rows.filter((r) => r.eventType === 'REVERSAL');
  const totalFees = fees.reduce((s, r) => s + Number(r.amount), 0);
  const totalReversals = reversals.reduce((s, r) => s + Number(r.amount), 0);
  const totalTxns = fees.reduce((s, r) => s + (r.metadata.txnCount ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="MiCamp · processing"
        subtitle="50/50 rev share on transaction fees · reversals netted · partner-level visibility"
        action={
          <ExportButton
            endpoint="/revenue/ledger/export"
            filters={new URLSearchParams({ stream: 'MICAMP' })}
            filenameHint="micamp_revenue_ledger"
          />
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Processing events" value={fees.length.toString()} hint="last 200 events" />
        <KpiCard
          label="Our share"
          value={formatMoney(totalFees)}
          hint="50% of gross fees reported"
        />
        <KpiCard
          label="Reversals"
          value={reversals.length.toString()}
          hint={`${formatMoney(totalReversals)} netted`}
        />
        <KpiCard
          label="Transactions"
          value={totalTxns.toLocaleString('en-AU')}
          hint="processed across the network"
        />
      </div>

      <SectionCard title="Processing events" subtitle="reverse-chronological" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Type</th>
                <th>Partner</th>
                <th className="text-right">Txns</th>
                <th className="text-right">Gross</th>
                <th className="text-right">Our share</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const negative = Number(r.amount) < 0;
                return (
                  <tr key={r.idempotencyKey}>
                    <td className="numeric text-muted whitespace-nowrap">
                      {formatDateTime(r.effectiveAt)}
                    </td>
                    <td>
                      <StatusPill>{r.eventType}</StatusPill>
                    </td>
                    <td className="numeric">
                      <code className="kbd">{r.partnerId.slice(0, 8)}</code>
                    </td>
                    <td className="numeric text-right text-ink2">{r.metadata.txnCount ?? '—'}</td>
                    <td className="numeric text-right text-ink2">
                      {r.metadata.gross ? formatMoney(r.metadata.gross) : '—'}
                    </td>
                    <td
                      className={`numeric text-right font-medium ${negative ? 'text-danger' : 'text-success'}`}
                    >
                      {negative ? '−' : ''}
                      {formatMoney(Math.abs(Number(r.amount)))}
                    </td>
                    <td className="text-[11px] text-muted">{r.metadata.reason ?? ''}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted py-8 text-center">
                    No MiCamp activity yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
