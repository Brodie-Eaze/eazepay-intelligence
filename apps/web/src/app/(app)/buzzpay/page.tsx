'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface LedgerRow {
  idempotencyKey: string;
  partnerId: string;
  lenderDecisionId: string | null;
  source: string;
  stream: string;
  eventType: string;
  amount: string;
  effectiveAt: string;
}

export default function BuzzPayDealBookPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['buzzpay.deals'],
    queryFn: () => api<{ data: LedgerRow[] }>('/revenue/ledger?stream=BUZZPAY&limit=100'),
  });

  const rows = q.data?.data ?? [];
  const fundings = rows.filter((r) => r.eventType === 'FUNDING');
  const clawbacks = rows.filter((r) => r.eventType === 'CLAWBACK');
  const totalFunded = fundings.reduce((s, r) => s + Number(r.amount), 0);
  const totalClawed = clawbacks.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="BuzzPay · deal book" subtitle="Every loan we have rev share on · funding, clawbacks, net revenue" />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Funding events" value={fundings.length.toString()} hint="last 100 events" />
        <KpiCard label="Funded revenue" value={formatMoney(totalFunded)} hint="EazePay rev share" />
        <KpiCard label="Clawbacks" value={clawbacks.length.toString()} hint={`${formatPct(fundings.length ? clawbacks.length / fundings.length : 0)} of fundings`} />
        <KpiCard label="Net" value={formatMoney(totalFunded + totalClawed)} hint="funded − clawed" />
      </div>

      <SectionCard title="Deal events" subtitle="reverse-chronological · click amount to follow the lender decision" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Type</th>
                <th>Partner</th>
                <th>Decision</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const negative = Number(r.amount) < 0;
                return (
                  <tr key={r.idempotencyKey}>
                    <td className="numeric text-muted whitespace-nowrap">{formatDateTime(r.effectiveAt)}</td>
                    <td><StatusPill>{r.eventType}</StatusPill></td>
                    <td className="numeric"><Link href={`/partners/${r.partnerId}`} className="text-accent hover:underline"><code className="kbd">{r.partnerId.slice(0, 8)}</code></Link></td>
                    <td className="numeric text-[11px] text-muted">{r.lenderDecisionId ? <code>{r.lenderDecisionId.slice(0, 8)}</code> : '—'}</td>
                    <td className={`numeric text-right font-medium ${negative ? 'text-danger' : 'text-success'}`}>
                      {negative ? '−' : ''}{formatMoney(Math.abs(Number(r.amount)))}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="text-muted py-8 text-center">No BuzzPay events yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
