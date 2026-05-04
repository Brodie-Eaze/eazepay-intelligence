'use client';

import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface IncomeRow {
  bucket: number;
  label: string;
  count: number;
  avgCreditScore: number | null;
  avgFundingEstimate: string | null;
}

export default function IncomePage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.income-distribution'],
    queryFn: () => api<IncomeRow[]>('/analytics/income-distribution'),
  });

  const rows = q.data ?? [];
  const total = rows.reduce((s, r) => s + r.count, 0);
  const provided = total - (rows.find((r) => r.bucket === -1)?.count ?? 0);
  const high = rows.filter((r) => r.bucket >= 120000).reduce((s, r) => s + r.count, 0);
  const low = (rows.find((r) => r.bucket === 0)?.count ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Income & affordability"
        subtitle="What the book actually earns · cross-tabulated with credit score and funding estimate"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Income provided" value={formatNumber(provided)} hint={`${formatPct(total ? provided / total : 0)} of apps`} />
        <KpiCard label="Under $50k" value={formatNumber(low)} hint={`${formatPct(provided ? low / provided : 0)} of those who disclosed`} />
        <KpiCard label="$120k+" value={formatNumber(high)} hint={`${formatPct(provided ? high / provided : 0)} of disclosers`} />
        <KpiCard label="Unknown" value={formatNumber(rows.find((r) => r.bucket === -1)?.count ?? 0)} hint="no income noted" />
      </div>

      <SectionCard title="Distribution by income band" bodyClassName="p-3">
        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="label" stroke="#94A3B8" fontSize={12} />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12 }}
                formatter={(v: number) => [v, 'Applications']}
              />
              <Bar dataKey="count" fill="#3B82F6" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="Income band ↔ credit / funding cross-tab" subtitle="how the bands correlate" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Income band</th>
                <th className="text-right">Applications</th>
                <th className="text-right">Share</th>
                <th className="text-right">Avg credit score</th>
                <th className="text-right">Avg funding estimate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bucket}>
                  <td className="text-ink font-medium">{r.label}</td>
                  <td className="numeric text-right text-ink">{formatNumber(r.count)}</td>
                  <td className="numeric text-right text-ink2">{formatPct(total ? r.count / total : 0)}</td>
                  <td className="numeric text-right text-ink2">{r.avgCreditScore ?? '—'}</td>
                  <td className="numeric text-right text-ink2">{r.avgFundingEstimate ? formatMoney(Math.round(Number(r.avgFundingEstimate))) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
