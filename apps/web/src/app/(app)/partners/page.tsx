'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { ExportButton } from '@/components/ExportButton';
import { SectionCard } from '@/components/SectionCard';
import { Monogram } from '@/components/Monogram';
import { MiniBar } from '@/components/MiniBar';
import { KpiCard } from '@/components/KpiCard';

interface LeaderboardResponse {
  leaderboard: Array<{
    partnerId: string;
    partnerLabel: string;
    tier: string;
    applications: number;
    approved: number;
    funded: number;
    revenue: string;
  }>;
  tiers: Array<{ tier: string; count: number }>;
}

export default function PartnersPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.partners'],
    queryFn: () => api<LeaderboardResponse>('/analytics/partners'),
  });

  const lb = q.data?.leaderboard ?? [];
  const maxRev = Math.max(1, ...lb.map((p) => Number(p.revenue)));
  const totalActive = (q.data?.tiers ?? []).reduce((s, t) => s + t.count, 0);
  const totalRev = lb.reduce((s, p) => s + Number(p.revenue), 0);
  const totalApps = lb.reduce((s, p) => s + p.applications, 0);
  const totalFunded = lb.reduce((s, p) => s + p.funded, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partners"
        subtitle="Every business deploying EazePay · ranked by 30-day revenue"
        action={<ExportButton endpoint="/partners/export" filenameHint="partners" />}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Active partners"
          value={totalActive.toLocaleString('en-AU')}
          hint="across the network"
        />
        <KpiCard label="30-day revenue" value={formatMoney(totalRev)} hint="ledger projection" />
        <KpiCard
          label="Applications (30d)"
          value={totalApps.toLocaleString('en-AU')}
          hint={`${formatPct(totalApps ? totalFunded / totalApps : 0)} funded`}
        />
        <KpiCard
          label="Avg per partner"
          value={formatMoney(totalActive ? totalRev / totalActive : 0)}
          hint="revenue average"
        />
      </div>

      <SectionCard
        title="Leaderboard"
        subtitle="click a row for the full partner microscope"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-6">#</th>
                <th>Partner</th>
                <th className="text-right">Applications</th>
                <th className="text-right">Approved</th>
                <th className="text-right">Funded</th>
                <th className="text-right">Revenue (30d)</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {lb.map((p, i) => (
                <tr key={p.partnerId}>
                  <td className="numeric text-muted">{i + 1}</td>
                  <td>
                    <Link
                      href={`/partners/${p.partnerId}`}
                      className="inline-flex items-center gap-2 text-ink hover:text-accent"
                    >
                      <Monogram label={p.partnerLabel} />
                      <span className="font-medium tracking-tight">{p.partnerLabel}</span>
                    </Link>
                  </td>
                  <td className="numeric text-right text-ink2">
                    {p.applications.toLocaleString('en-AU')}
                  </td>
                  <td className="numeric text-right text-ink2">
                    {p.approved.toLocaleString('en-AU')}
                  </td>
                  <td className="numeric text-right text-ink">
                    {p.funded.toLocaleString('en-AU')}
                  </td>
                  <td className="numeric text-right text-ink font-medium">
                    {formatMoney(p.revenue)}
                  </td>
                  <td className="w-32">
                    <MiniBar value={Number(p.revenue) / maxRev} />
                  </td>
                </tr>
              ))}
              {lb.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-8">
                    No partner activity yet.
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
