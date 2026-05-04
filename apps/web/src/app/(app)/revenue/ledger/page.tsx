'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

interface LedgerRow {
  idempotencyKey: string;
  partnerId: string;
  lenderDecisionId: string | null;
  source: string;
  stream: string;
  eventType: string;
  amount: string;
  currency: string;
  effectiveAt: string;
  recordedAt: string;
  metadata: Record<string, unknown>;
}

export default function LedgerPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['revenue.ledger'],
    queryFn: () => api<{ data: LedgerRow[] }>('/revenue/ledger?limit=100'),
  });

  const rows = q.data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Revenue ledger" subtitle="Append-only journal · every dollar reconciles to a webhook" />
      <SectionCard title={`${rows.length} most recent events`} subtitle="effective_at desc" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Stream</th>
                <th>Type</th>
                <th>Partner</th>
                <th className="text-right">Amount</th>
                <th>Idempotency key</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const negative = Number(r.amount) < 0;
                return (
                  <tr key={r.idempotencyKey}>
                    <td className="numeric text-muted whitespace-nowrap">{formatDateTime(r.effectiveAt)}</td>
                    <td><StatusPill>{r.stream}</StatusPill></td>
                    <td><StatusPill>{r.eventType}</StatusPill></td>
                    <td className="numeric"><code className="kbd">{r.partnerId.slice(0, 8)}</code></td>
                    <td className={`numeric text-right font-medium ${negative ? 'text-danger' : 'text-success'}`}>
                      {negative ? '−' : ''}{formatMoney(Math.abs(Number(r.amount)))}
                    </td>
                    <td className="text-[11px] text-muted truncate max-w-[280px]"><code>{r.idempotencyKey}</code></td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={6} className="text-center text-muted py-8">No ledger events yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
