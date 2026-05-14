'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from 'recharts';
import { api } from '@/lib/api';
import { formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface PropRow {
  bucketLow: number;
  bucketHigh: number;
  label: string;
  count: number;
  approvalRate: number;
  fundingRate: number;
}

export default function PropensityPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.propensity'],
    queryFn: () => api<PropRow[]>('/analytics/propensity-calibration'),
  });

  const rows = q.data ?? [];
  const totalScored = rows.reduce((s, r) => s + r.count, 0);
  const overallApproval = totalScored
    ? rows.reduce((s, r) => s + r.approvalRate * r.count, 0) / totalScored
    : 0;
  const overallFunding = totalScored
    ? rows.reduce((s, r) => s + r.fundingRate * r.count, 0) / totalScored
    : 0;

  // Calibration delta — for each bucket, how much actual approval rate differs from the bucket midpoint
  const meanAbsErr = rows.length
    ? rows.reduce(
        (s, r) => s + Math.abs(r.approvalRate - (r.bucketLow + r.bucketHigh) / 2) * r.count,
        0,
      ) / Math.max(1, totalScored)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Propensity calibration"
        subtitle="HighSale Pixie sits in front of the BNPL decision engine. This is whether its propensity score actually predicts what happens next."
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Scored applications"
          value={formatNumber(totalScored)}
          hint="propensity present"
        />
        <KpiCard
          label="Overall approval"
          value={formatPct(overallApproval)}
          hint="across all buckets"
        />
        <KpiCard
          label="Overall funding"
          value={formatPct(overallFunding)}
          hint="across all buckets"
        />
        <KpiCard
          label="Calibration MAE"
          value={formatPct(meanAbsErr)}
          hint="lower = better predictions"
        />
      </div>

      <SectionCard
        title="Predicted vs actual"
        subtitle="bars are application count per propensity bucket · the diagonal is what perfect calibration looks like · lines are observed rates"
        bodyClassName="p-3"
      >
        <div style={{ height: 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="label" stroke="#94A3B8" fontSize={12} />
              <YAxis yAxisId="left" stroke="#94A3B8" fontSize={11} />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#94A3B8"
                fontSize={11}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                domain={[0, 1]}
              />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) =>
                  name === 'count'
                    ? [v, 'Applications']
                    : [
                        `${(v * 100).toFixed(1)}%`,
                        name === 'approvalRate' ? 'Approval rate' : 'Funding rate',
                      ]
                }
              />
              <Bar yAxisId="left" dataKey="count" fill="#CBD5E1" radius={[4, 4, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="approvalRate"
                stroke="#3B82F6"
                strokeWidth={2}
                dot={{ r: 4, fill: '#3B82F6' }}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="fundingRate"
                stroke="#0F172A"
                strokeWidth={2}
                dot={{ r: 4, fill: '#0F172A' }}
              />
              <ReferenceLine
                yAxisId="right"
                segment={[{ x: 0, y: 0.05 } as never, { x: rows.length - 1, y: 0.95 } as never]}
                stroke="#94A3B8"
                strokeDasharray="3 3"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-5 px-3 pt-3 text-[11px] text-muted">
          <Legend color="#CBD5E1" label="Application volume" />
          <Legend color="#3B82F6" label="Approval rate" />
          <Legend color="#0F172A" label="Funding rate" />
          <Legend color="#94A3B8" label="Perfect calibration" dashed />
        </div>
      </SectionCard>

      <SectionCard
        title="Bucket detail"
        subtitle="if approval rate ≪ propensity, Pixie is over-scoring · if ≫, under-scoring"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Propensity bucket</th>
                <th className="text-right">Apps</th>
                <th className="text-right">Predicted (midpoint)</th>
                <th className="text-right">Actual approval</th>
                <th className="text-right">Calibration delta</th>
                <th className="text-right">Funding rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const mid = (r.bucketLow + r.bucketHigh) / 2;
                const delta = r.approvalRate - mid;
                const tone =
                  Math.abs(delta) < 0.05
                    ? 'text-success'
                    : Math.abs(delta) < 0.15
                      ? 'text-warn'
                      : 'text-danger';
                return (
                  <tr key={r.label}>
                    <td className="text-ink font-medium">{r.label}</td>
                    <td className="numeric text-right text-ink">{formatNumber(r.count)}</td>
                    <td className="numeric text-right text-muted">{formatPct(mid)}</td>
                    <td className="numeric text-right text-ink2">{formatPct(r.approvalRate)}</td>
                    <td className={`numeric text-right font-medium ${tone}`}>
                      {delta > 0 ? '+' : ''}
                      {(delta * 100).toFixed(1)}%
                    </td>
                    <td className="numeric text-right text-ink2">{formatPct(r.fundingRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function Legend({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-0.5 w-5"
        style={{
          background: color,
          borderTop: dashed ? `2px dashed ${color}` : undefined,
          height: dashed ? 0 : undefined,
        }}
      />
      <span>{label}</span>
    </span>
  );
}
