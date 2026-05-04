'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

interface ClawbackRow {
  idempotencyKey: string;
  partnerId: string;
  stream: string;
  eventType: string;
  amount: string;
  effectiveAt: string;
  metadata: { reason?: string };
}

export default function ClawbacksPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['revenue.clawbacks'],
    queryFn: () => api<ClawbackRow[]>('/revenue/clawbacks'),
  });

  const rows = q.data ?? [];
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clawbacks & reversals"
        subtitle="Negative revenue events · what came back out of the books"
      />

      <SectionCard
        title="Total clawback exposure"
        subtitle={`${rows.length} events`}
        bodyClassName="p-5"
      >
        <div className="numeric text-3xl text-danger font-semibold">−{formatMoney(Math.abs(total))}</div>
        <div className="text-xs text-muted mt-1">netted into the ledger total · investor reporting reflects this</div>
      </SectionCard>

      <SectionCard title="Recent clawbacks" subtitle="effective_at desc" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Stream</th>
                <th>Type</th>
                <th>Partner</th>
                <th>Reason</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.idempotencyKey}>
                  <td className="numeric text-muted whitespace-nowrap">{formatDateTime(r.effectiveAt)}</td>
                  <td><StatusPill>{r.stream}</StatusPill></td>
                  <td><StatusPill>{r.eventType}</StatusPill></td>
                  <td className="numeric"><code className="kbd">{r.partnerId.slice(0, 8)}</code></td>
                  <td className="text-ink2">{r.metadata?.reason ?? '—'}</td>
                  <td className="numeric text-right text-danger font-medium">−{formatMoney(Math.abs(Number(r.amount)))}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="text-center text-muted py-8">No clawbacks recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
