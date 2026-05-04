'use client';

import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { RiskBand } from '@/components/RiskBand';

interface RiskRow {
  bucket: number;
  label: string;
  riskBand: string;
  count: number;
  avgIncome: string | null;
  avgPropensity: string | null;
}

const COLORS: Record<string, string> = {
  PRIME: '#0F172A',
  NEAR_PRIME: '#1D4ED8',
  SUBPRIME: '#3B82F6',
  DEEP_SUBPRIME: '#93C5FD',
  UNSCORED: '#CBD5E1',
};

export default function RiskProfilesPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.risk-distribution'],
    queryFn: () => api<RiskRow[]>('/analytics/risk-distribution'),
  });

  const rows = q.data ?? [];
  const total = rows.reduce((s, r) => s + r.count, 0);
  const prime = rows.find((r) => r.riskBand === 'PRIME')?.count ?? 0;
  const subprime = (rows.find((r) => r.riskBand === 'SUBPRIME')?.count ?? 0)
    + (rows.find((r) => r.riskBand === 'DEEP_SUBPRIME')?.count ?? 0);
  const unscored = rows.find((r) => r.riskBand === 'UNSCORED')?.count ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk profiles"
        subtitle="Where the customer book sits on the credit curve · the underwriting microscope"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Applications scored" value={formatNumber(total - unscored)} hint={`${formatPct(total ? (total - unscored) / total : 0)} of all apps`} />
        <KpiCard label="Prime (≥720)" value={formatNumber(prime)} hint={`${formatPct(total ? prime / total : 0)} of book`} />
        <KpiCard label="Subprime (<660)" value={formatNumber(subprime)} hint={`${formatPct(total ? subprime / total : 0)} of book`} />
        <KpiCard label="Unscored" value={formatNumber(unscored)} hint="no Pixie credit input" />
      </div>

      <SectionCard title="Distribution by credit band" subtitle="every application · counts on the y-axis · click a band to filter the customer book" bodyClassName="p-3">
        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="label" stroke="#94A3B8" fontSize={12} />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12 }}
                formatter={(v: number, name: string) => [v, name === 'count' ? 'Applications' : name]}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {rows.map((r) => <Cell key={r.bucket} fill={COLORS[r.riskBand] ?? '#3B82F6'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="Credit band detail" subtitle="how each band looks across income and propensity" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Band</th>
                <th>Score range</th>
                <th className="text-right">Applications</th>
                <th className="text-right">Share</th>
                <th className="text-right">Avg income</th>
                <th className="text-right">Avg propensity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bucket}>
                  <td><RiskBand band={r.riskBand} /></td>
                  <td className="text-ink2">{r.label}</td>
                  <td className="numeric text-right text-ink">{formatNumber(r.count)}</td>
                  <td className="numeric text-right text-ink2">{formatPct(total ? r.count / total : 0)}</td>
                  <td className="numeric text-right text-ink2">{r.avgIncome ? formatMoney(Math.round(Number(r.avgIncome))) : '—'}</td>
                  <td className="numeric text-right text-ink2">{r.avgPropensity ? `${(Number(r.avgPropensity) * 100).toFixed(0)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
