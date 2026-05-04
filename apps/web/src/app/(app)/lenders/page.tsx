'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney, formatPct } from '@/lib/format';
import type { WaterfallRow } from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { MiniBar } from '@/components/MiniBar';
import { KpiCard } from '@/components/KpiCard';

export default function LendersPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.lenders'],
    queryFn: () => api<WaterfallRow[]>('/analytics/lenders'),
  });

  const rows = q.data ?? [];
  const totals = rows.reduce(
    (a, r) => {
      a.submitted += r.submitted;
      a.approved += r.approved;
      a.funded += r.funded;
      a.fundedAmt += Number(r.totalFunded);
      return a;
    },
    { submitted: 0, approved: 0, funded: 0, fundedAmt: 0 },
  );
  const maxFunded = Math.max(1, ...rows.map((r) => Number(r.totalFunded)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lender waterfall"
        subtitle="Per-lender approval, funding and APR performance · across the entire network"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Submissions" value={totals.submitted.toLocaleString('en-AU')} hint="across all lenders" />
        <KpiCard label="Approved" value={totals.approved.toLocaleString('en-AU')} hint={`${formatPct(totals.submitted ? totals.approved / totals.submitted : 0)} approval rate`} />
        <KpiCard label="Funded" value={totals.funded.toLocaleString('en-AU')} hint={`${formatPct(totals.approved ? totals.funded / totals.approved : 0)} funding rate`} />
        <KpiCard label="Funded volume" value={formatMoney(totals.fundedAmt)} hint="lifetime · all lenders" />
      </div>

      <SectionCard title="Waterfall" subtitle={`${rows.length} active lenders`} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Lender</th>
                <th>Tier</th>
                <th className="text-right">Submitted</th>
                <th className="text-right">Approved</th>
                <th className="text-right">Funded</th>
                <th className="text-right">Approval</th>
                <th className="text-right">Funding</th>
                <th className="text-right">Avg APR</th>
                <th className="text-right">Funded $</th>
                <th>Volume share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lenderName}>
                  <td className="font-medium text-ink">{r.lenderName}</td>
                  <td><StatusPill>{r.lenderTier}</StatusPill></td>
                  <td className="numeric text-right text-ink2">{r.submitted.toLocaleString('en-AU')}</td>
                  <td className="numeric text-right text-ink2">{r.approved.toLocaleString('en-AU')}</td>
                  <td className="numeric text-right text-ink">{r.funded.toLocaleString('en-AU')}</td>
                  <td className="numeric text-right text-ink2">{formatPct(r.approvalRate)}</td>
                  <td className="numeric text-right text-ink2">{formatPct(r.fundingRate)}</td>
                  <td className="numeric text-right text-ink2">{r.avgApr ? `${Number(r.avgApr).toFixed(2)}%` : '—'}</td>
                  <td className="numeric text-right text-ink font-medium">{formatMoney(r.totalFunded)}</td>
                  <td className="w-32"><MiniBar value={Number(r.totalFunded) / maxFunded} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} className="text-center text-muted py-8">No lender activity yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
