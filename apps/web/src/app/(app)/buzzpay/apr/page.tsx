'use client';

import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
import { formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface WaterfallRow {
  lenderName: string;
  lenderTier: string;
  submitted: number;
  approved: number;
  funded: number;
  approvalRate: string;
  fundingRate: string;
  avgApr: string | null;
  totalFunded: string;
}

export default function AprMixPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.lenders'],
    queryFn: () => api<WaterfallRow[]>('/analytics/lenders'),
  });

  const rows = q.data ?? [];
  const aprs = rows.filter((r) => r.avgApr).map((r) => ({ name: r.lenderName, apr: Number(r.avgApr) }));
  const avg = aprs.length ? aprs.reduce((s, a) => s + a.apr, 0) / aprs.length : 0;
  const min = aprs.length ? Math.min(...aprs.map((a) => a.apr)) : 0;
  const max = aprs.length ? Math.max(...aprs.map((a) => a.apr)) : 0;

  const tierBuckets = rows.reduce<Record<string, { tier: string; submitted: number; approved: number; approvalRate: number }>>((acc, r) => {
    if (!acc[r.lenderTier]) acc[r.lenderTier] = { tier: r.lenderTier, submitted: 0, approved: 0, approvalRate: 0 };
    acc[r.lenderTier]!.submitted += r.submitted;
    acc[r.lenderTier]!.approved += r.approved;
    acc[r.lenderTier]!.approvalRate = acc[r.lenderTier]!.submitted ? acc[r.lenderTier]!.approved / acc[r.lenderTier]!.submitted : 0;
    return acc;
  }, {});
  const tierRows = Object.values(tierBuckets);

  return (
    <div className="space-y-6">
      <PageHeader title="BuzzPay · APR mix" subtitle="Where the network sits on the rate curve · per lender · per tier" />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Avg APR" value={`${avg.toFixed(2)}%`} hint="across all lenders" />
        <KpiCard label="Min APR" value={`${min.toFixed(2)}%`} hint="prime tier" />
        <KpiCard label="Max APR" value={`${max.toFixed(2)}%`} hint="subprime tier" />
      </div>

      <SectionCard title="Average APR by lender" bodyClassName="p-3">
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={aprs}>
              <CartesianGrid stroke="#E5E7EB" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="name" stroke="#94A3B8" fontSize={11} />
              <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={(v) => `${v}%`} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12 }} formatter={(v: number) => [`${v.toFixed(2)}%`, 'Avg APR']} />
              <Bar dataKey="apr" fill="#3B82F6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="Approval performance by tier" bodyClassName="p-0">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tier</th>
              <th className="text-right">Submitted</th>
              <th className="text-right">Approved</th>
              <th className="text-right">Approval rate</th>
            </tr>
          </thead>
          <tbody>
            {tierRows.map((t) => (
              <tr key={t.tier}>
                <td><StatusPill>{t.tier}</StatusPill></td>
                <td className="numeric text-right text-ink2">{t.submitted.toLocaleString('en-AU')}</td>
                <td className="numeric text-right text-ink">{t.approved.toLocaleString('en-AU')}</td>
                <td className="numeric text-right text-ink2">{formatPct(t.approvalRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}
