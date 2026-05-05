'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from 'recharts';
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

interface CrossRow {
  incomeLabel: string;
  incomeBucket: number;
  riskBand: string;
  riskBucket: number;
  count: number;
  avgFundingEstimate: string | null;
}

interface LtiRow {
  bucket: number;
  label: string;
  count: number;
  avgCreditScore: number | null;
  tone: 'comfortable' | 'moderate' | 'stretched';
}

const RISK_ORDER = ['UNSCORED', 'DEEP_SUBPRIME', 'SUBPRIME', 'NEAR_PRIME', 'PRIME'] as const;
const RISK_LABEL: Record<string, string> = {
  UNSCORED: 'Unscored',
  DEEP_SUBPRIME: '< 580',
  SUBPRIME: '580–659',
  NEAR_PRIME: '660–719',
  PRIME: '720+',
};
const TONE_FILL: Record<LtiRow['tone'], string> = {
  comfortable: '#0F172A',
  moderate: '#1D4ED8',
  stretched: '#93C5FD',
};

export default function IncomePage(): JSX.Element {
  const dist = useQuery({
    queryKey: ['analytics.income-distribution'],
    queryFn: () => api<IncomeRow[]>('/analytics/income-distribution'),
  });
  const cross = useQuery({
    queryKey: ['analytics.income-cross-risk'],
    queryFn: () => api<CrossRow[]>('/analytics/income-cross-risk'),
  });
  const lti = useQuery({
    queryKey: ['analytics.lti-distribution'],
    queryFn: () => api<LtiRow[]>('/analytics/lti-distribution'),
  });

  const rows = dist.data ?? [];
  const crossRows = cross.data ?? [];
  const ltiRows = lti.data ?? [];

  const total = rows.reduce((s, r) => s + r.count, 0);
  const provided = total - (rows.find((r) => r.bucket === -1)?.count ?? 0);
  const high = rows.filter((r) => r.bucket >= 120000).reduce((s, r) => s + r.count, 0);
  const low = rows.find((r) => r.bucket === 0)?.count ?? 0;

  // Build heatmap pivot: rows = income bucket (incl. -1), cols = risk band
  const incomeLabels = Array.from(
    new Map(crossRows.map((r) => [r.incomeBucket, r.incomeLabel])).entries(),
  ).sort((a, b) => a[0] - b[0]);
  const heatmap: Record<number, Record<string, number>> = {};
  let maxCell = 0;
  for (const r of crossRows) {
    if (!heatmap[r.incomeBucket]) heatmap[r.incomeBucket] = {};
    heatmap[r.incomeBucket]![r.riskBand] = r.count;
    if (r.count > maxCell) maxCell = r.count;
  }

  const ltiTotal = ltiRows.reduce((s, r) => s + r.count, 0);
  const stretched = ltiRows.filter((r) => r.tone === 'stretched').reduce((s, r) => s + r.count, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Income & affordability"
        subtitle="What the book actually earns · cross-tabulated with credit and loan-to-income"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Income provided"
          value={formatNumber(provided)}
          hint={`${formatPct(total ? provided / total : 0)} of apps`}
        />
        <KpiCard
          label="Under $50k"
          value={formatNumber(low)}
          hint={`${formatPct(provided ? low / provided : 0)} of disclosers`}
        />
        <KpiCard
          label="$120k+"
          value={formatNumber(high)}
          hint={`${formatPct(provided ? high / provided : 0)} of disclosers`}
        />
        <KpiCard
          label="Stretched (LTI ≥50%)"
          value={formatNumber(stretched)}
          hint={`${formatPct(ltiTotal ? stretched / ltiTotal : 0)} of funded loans`}
        />
      </div>

      <SectionCard title="Distribution by income band" bodyClassName="p-3">
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="label" stroke="#94A3B8" fontSize={12} />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number) => [v, 'Applications']}
              />
              <Bar dataKey="count" fill="#1D4ED8" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard
        title="Income × credit heatmap"
        subtitle="darker cells = more applications · the diagonal is healthy correlation"
        bodyClassName="p-5"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left text-muted font-medium pb-2 pr-3">Income ↓ / Credit →</th>
                {RISK_ORDER.map((band) => (
                  <th
                    key={band}
                    className="text-right text-muted font-medium pb-2 px-2 whitespace-nowrap"
                  >
                    {RISK_LABEL[band]}
                  </th>
                ))}
                <th className="text-right text-muted font-medium pb-2 pl-3">Total</th>
              </tr>
            </thead>
            <tbody>
              {incomeLabels.map(([bucket, label]) => {
                const rowTotal = RISK_ORDER.reduce((s, b) => s + (heatmap[bucket]?.[b] ?? 0), 0);
                return (
                  <tr key={bucket}>
                    <td className="text-ink2 font-medium py-1 pr-3 whitespace-nowrap">{label}</td>
                    {RISK_ORDER.map((band) => {
                      const v = heatmap[bucket]?.[band] ?? 0;
                      const intensity = maxCell ? v / maxCell : 0;
                      const bg = `rgba(29, 78, 216, ${0.06 + intensity * 0.55})`;
                      const fg = intensity > 0.5 ? '#FFFFFF' : '#0F172A';
                      return (
                        <td key={band} className="px-1 py-1">
                          <div
                            className="numeric text-right rounded-md px-2 py-1.5 tabular-nums"
                            style={{
                              background: v ? bg : 'transparent',
                              color: v ? fg : '#94A3B8',
                            }}
                          >
                            {v ? formatNumber(v) : '—'}
                          </div>
                        </td>
                      );
                    })}
                    <td className="numeric text-right text-ink font-medium pl-3">
                      {formatNumber(rowTotal)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Loan-to-income on funded loans"
        subtitle="affordability flag · over 50% means the customer is stretched"
        bodyClassName="p-3"
      >
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={ltiRows} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="label" stroke="#94A3B8" fontSize={12} />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number) => [v, 'Funded loans']}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {ltiRows.map((r) => (
                  <Cell key={r.bucket} fill={TONE_FILL[r.tone]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-5 px-3 pt-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: TONE_FILL.comfortable }}
            />
            comfortable (&lt;20%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: TONE_FILL.moderate }} />
            moderate (20–50%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: TONE_FILL.stretched }} />
            stretched (≥50%)
          </span>
        </div>
      </SectionCard>

      <SectionCard title="Income band ↔ credit / funding cross-tab" bodyClassName="p-0">
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
                  <td className="numeric text-right text-ink2">
                    {formatPct(total ? r.count / total : 0)}
                  </td>
                  <td className="numeric text-right text-ink2">{r.avgCreditScore ?? '—'}</td>
                  <td className="numeric text-right text-ink2">
                    {r.avgFundingEstimate
                      ? formatMoney(Math.round(Number(r.avgFundingEstimate)))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
