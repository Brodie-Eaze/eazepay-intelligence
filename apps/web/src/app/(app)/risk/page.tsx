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
import { RiskBand } from '@/components/RiskBand';

interface RiskRow {
  bucket: number;
  label: string;
  riskBand: string;
  count: number;
  avgIncome: string | null;
  avgPropensity: string | null;
}

interface OutcomeRow {
  bucket: number;
  label: string;
  riskBand: string;
  applications: number;
  decisions: number;
  approved: number;
  funded: number;
  approvalRate: number;
  fundingRate: number;
  avgApr: string | null;
  totalFunded: string;
  totalClawback: string;
  clawbackRate: number;
}

interface TrendRow {
  week: string;
  riskBand: string;
  count: number;
}

const BAND_ORDER = ['PRIME', 'NEAR_PRIME', 'SUBPRIME', 'DEEP_SUBPRIME', 'UNSCORED'] as const;
const COLORS: Record<string, string> = {
  PRIME: '#0F172A',
  NEAR_PRIME: '#1D4ED8',
  SUBPRIME: '#3B82F6',
  DEEP_SUBPRIME: '#93C5FD',
  UNSCORED: '#CBD5E1',
};

export default function RiskProfilesPage(): JSX.Element {
  const dist = useQuery({
    queryKey: ['analytics.risk-distribution'],
    queryFn: () => api<RiskRow[]>('/analytics/risk-distribution'),
  });
  const outcome = useQuery({
    queryKey: ['analytics.risk-by-outcome'],
    queryFn: () => api<OutcomeRow[]>('/analytics/risk-by-outcome'),
  });
  const trend = useQuery({
    queryKey: ['analytics.risk-trend'],
    queryFn: () => api<TrendRow[]>('/analytics/risk-trend'),
  });

  const rows = dist.data ?? [];
  const outcomes = outcome.data ?? [];
  const total = rows.reduce((s, r) => s + r.count, 0);
  const prime = rows.find((r) => r.riskBand === 'PRIME')?.count ?? 0;
  const subprime =
    (rows.find((r) => r.riskBand === 'SUBPRIME')?.count ?? 0) +
    (rows.find((r) => r.riskBand === 'DEEP_SUBPRIME')?.count ?? 0);
  const unscored = rows.find((r) => r.riskBand === 'UNSCORED')?.count ?? 0;

  // Pivot trend rows into per-week stacks
  const weeks = Array.from(new Set((trend.data ?? []).map((r) => r.week))).sort();
  const trendData = weeks.map((w) => {
    const stack: Record<string, number | string> = { week: shortWeek(w) };
    for (const band of BAND_ORDER) stack[band] = 0;
    for (const r of trend.data ?? []) {
      if (r.week === w) stack[r.riskBand] = r.count;
    }
    return stack;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk profiles"
        subtitle="Where the customer book sits on the credit curve · what each band actually does downstream"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Applications scored"
          value={formatNumber(total - unscored)}
          hint={`${formatPct(total ? (total - unscored) / total : 0)} of all apps`}
        />
        <KpiCard
          label="Prime (≥720)"
          value={formatNumber(prime)}
          hint={`${formatPct(total ? prime / total : 0)} of book`}
        />
        <KpiCard
          label="Subprime (<660)"
          value={formatNumber(subprime)}
          hint={`${formatPct(total ? subprime / total : 0)} of book`}
        />
        <KpiCard label="Unscored" value={formatNumber(unscored)} hint="no Pixie credit input" />
      </div>

      <SectionCard
        title="Distribution by credit band"
        subtitle="every application · counts on the y-axis"
        bodyClassName="p-3"
      >
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
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {rows.map((r) => (
                  <Cell key={r.bucket} fill={COLORS[r.riskBand] ?? '#3B82F6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard
        title="Outcomes by band"
        subtitle="approval, funding, weighted APR, clawback exposure · the proof Pixie's pre-qual is doing its job"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Band</th>
                <th>Score range</th>
                <th className="text-right">Apps</th>
                <th className="text-right">Decisions</th>
                <th className="text-right">Approval rate</th>
                <th className="text-right">Funding rate</th>
                <th className="text-right">Avg APR</th>
                <th className="text-right">Total funded</th>
                <th className="text-right">Clawback %</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((r) => {
                const cb = r.clawbackRate;
                const cbTone = cb < 0.02 ? 'text-ink2' : cb < 0.05 ? 'text-ink' : 'text-accent';
                return (
                  <tr key={r.bucket}>
                    <td>
                      <RiskBand band={r.riskBand} />
                    </td>
                    <td className="text-ink2">{r.label}</td>
                    <td className="numeric text-right text-ink">{formatNumber(r.applications)}</td>
                    <td className="numeric text-right text-ink2">{formatNumber(r.decisions)}</td>
                    <td className="numeric text-right text-ink">{formatPct(r.approvalRate)}</td>
                    <td className="numeric text-right text-ink2">{formatPct(r.fundingRate)}</td>
                    <td className="numeric text-right text-ink2">
                      {r.avgApr ? `${(Number(r.avgApr) * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="numeric text-right text-ink font-medium">
                      {Number(r.totalFunded) > 0 ? formatMoney(r.totalFunded) : '—'}
                    </td>
                    <td className={`numeric text-right font-medium ${cbTone}`}>{formatPct(cb)}</td>
                  </tr>
                );
              })}
              {outcomes.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-muted py-6 text-center">
                    No decisions in window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Mix over time"
        subtitle="weekly application volume stacked by band · last 12 weeks"
        bodyClassName="p-3"
      >
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trendData} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="week" stroke="#94A3B8" fontSize={11} />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              {BAND_ORDER.map((band) => (
                <Bar key={band} dataKey={band} stackId="a" fill={COLORS[band]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap items-center gap-4 px-3 pt-3 text-[11px] text-muted">
          {BAND_ORDER.map((band) => (
            <span key={band} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[band] }} />
              <span>{band.replace(/_/g, ' ').toLowerCase()}</span>
            </span>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Credit band cross-section"
        subtitle="income and Pixie propensity by band"
        bodyClassName="p-0"
      >
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
                  <td>
                    <RiskBand band={r.riskBand} />
                  </td>
                  <td className="text-ink2">{r.label}</td>
                  <td className="numeric text-right text-ink">{formatNumber(r.count)}</td>
                  <td className="numeric text-right text-ink2">
                    {formatPct(total ? r.count / total : 0)}
                  </td>
                  <td className="numeric text-right text-ink2">
                    {r.avgIncome ? formatMoney(Math.round(Number(r.avgIncome))) : '—'}
                  </td>
                  <td className="numeric text-right text-ink2">
                    {r.avgPropensity ? `${(Number(r.avgPropensity) * 100).toFixed(0)}%` : '—'}
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

function shortWeek(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
