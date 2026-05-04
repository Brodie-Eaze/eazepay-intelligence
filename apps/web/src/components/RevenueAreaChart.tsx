'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useMemo } from 'react';
import type { RevenueByStreamRow } from '@/lib/types';

interface Props {
  data: RevenueByStreamRow[];
  height?: number;
}

const COLORS = {
  BUZZPAY: '#0F172A',
  PIXIE:   '#3B82F6',
  MICAMP:  '#93C5FD',
} as const;

export function RevenueAreaChart({ data, height = 280 }: Props): JSX.Element {
  const series = useMemo(() => {
    const map = new Map<string, { bucket: string; BUZZPAY: number; PIXIE: number; MICAMP: number }>();
    for (const row of data) {
      const k = row.bucket;
      const cur = map.get(k) ?? { bucket: k, BUZZPAY: 0, PIXIE: 0, MICAMP: 0 };
      cur[row.stream] = Number(row.amount);
      map.set(k, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [data]);

  if (series.length === 0) {
    return <div className="text-sm text-muted px-5 py-8 text-center">No revenue events in this window.</div>;
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
          <defs>
            {(['BUZZPAY', 'PIXIE', 'MICAMP'] as const).map((s) => (
              <linearGradient key={s} id={`fill-${s}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS[s]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLORS[s]} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="#E5E7EB" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(v) => new Date(v).toLocaleDateString('en-AU', { month: 'short', day: 'numeric' })}
            stroke="#94A3B8"
            fontSize={11}
            tickMargin={8}
          />
          <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
          <Tooltip
            contentStyle={{
              background: '#FFFFFF',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 12,
              boxShadow: '0 4px 12px rgba(15,23,42,0.06)',
            }}
            labelStyle={{ color: '#0B1220', fontWeight: 600 }}
            labelFormatter={(v) => new Date(v).toLocaleDateString('en-AU')}
            formatter={(v: number, name: string) => [`$${v.toLocaleString('en-AU')}`, name]}
          />
          {(['BUZZPAY', 'PIXIE', 'MICAMP'] as const).map((s) => (
            <Area key={s} type="monotone" dataKey={s} stackId="1" stroke={COLORS[s]} strokeWidth={1.5} fill={`url(#fill-${s})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
