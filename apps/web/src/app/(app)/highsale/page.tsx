'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';

interface PixieBP {
  collectiveLast24h: number;
  threshold: number;
  aboveBreakpoint: boolean;
}
interface PixieMargin {
  windowDays: number;
  totalMargin: string;
  totalPulls: number;
}
interface PixieRow {
  partnerId: string;
  period: string;
  periodStart: string;
  pulls: number;
  cumulative: number;
  costPerPull: string;
  chargePerPull: string;
  profitPerPull: string;
  totalRevenue: string;
}

const BASE_COST = 1.0;
const BASE_CHARGE = 3.0;

export default function HighSalePage(): JSX.Element {
  const bp = useQuery({
    queryKey: ['highsale.bp'],
    queryFn: () => api<PixieBP>('/pixie/breakpoint-status'),
  });
  const margin = useQuery({
    queryKey: ['highsale.margin'],
    queryFn: () => api<PixieMargin>('/pixie/margin'),
  });
  const usage = useQuery({
    queryKey: ['highsale.usage'],
    queryFn: () => api<PixieRow[]>('/pixie/usage?period=DAILY'),
  });

  const breakpoint = bp.data?.threshold ?? 25_000;
  const collective = bp.data?.collectiveLast24h ?? 0;
  const above = bp.data?.aboveBreakpoint ?? false;
  const ratio = Math.min(1, collective / breakpoint);

  // Build the curve once
  const curve = Array.from({ length: 41 }).map((_, i) => {
    const x = Math.round((breakpoint * 2 * i) / 40);
    const cost = x >= breakpoint ? BASE_COST : BASE_COST * (2 - x / breakpoint);
    return {
      collective: x,
      cost: Number(cost.toFixed(2)),
      margin: Number((BASE_CHARGE - cost).toFixed(2)),
    };
  });

  const usageRows = usage.data ?? [];
  const tableMax = Math.max(1, ...usageRows.map((r) => Number(r.totalRevenue)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="HighSale"
        subtitle="Pixie smart-form pre-qualification · sits in front of every BNPL application"
      />

      {/* Top KPI strip — what's happening right now */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Pulls (24h)"
          value={formatNumber(collective)}
          hint={`${formatNumber(breakpoint)} breakpoint`}
        />
        <KpiCard
          label="Margin / pull"
          value={above ? `$${(BASE_CHARGE - BASE_COST).toFixed(2)}` : 'sliding'}
          hint={above ? 'above breakpoint' : 'subsidised'}
        />
        <KpiCard
          label="30-day margin"
          value={formatMoney(margin.data?.totalMargin ?? 0)}
          hint="all partners"
        />
        <KpiCard
          label="30-day pulls"
          value={formatNumber(margin.data?.totalPulls ?? 0)}
          hint="collective volume"
        />
      </div>

      {/* Breakpoint progress */}
      <SectionCard
        title="Breakpoint progress"
        subtitle={
          above ? 'in full-margin territory' : 'still subsidised — drive volume to unlock $2/pull'
        }
      >
        <div className="flex items-baseline justify-between mb-2">
          <span className="numeric text-2xl font-semibold text-ink tracking-tight">
            {formatNumber(collective)}
          </span>
          <span className="text-xs text-muted numeric">/ {formatNumber(breakpoint)}</span>
        </div>
        <MiniBar value={ratio} className="h-2.5" />
        <div className="text-[11px] text-muted mt-2">
          last 24h collective volume across the whole network
        </div>
      </SectionCard>

      {/* The pricing curve */}
      <SectionCard
        title="Pricing curve"
        subtitle="x-axis: collective daily pulls · y-axis: $ per pull · vertical lines mark the breakpoint and where we sit now"
        bodyClassName="p-3"
      >
        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={curve} margin={{ top: 10, right: 20, bottom: 8, left: 8 }}>
              <defs>
                <linearGradient id="margin-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#3B82F6" stopOpacity={0.04} />
                </linearGradient>
                <linearGradient id="cost-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0F172A" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#0F172A" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#EEF1F5" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="collective"
                stroke="#94A3B8"
                fontSize={11}
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
              />
              <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) => [`$${v.toFixed(2)}`, name]}
                labelFormatter={(v) => `${formatNumber(Number(v))} collective pulls`}
              />
              <Area
                type="monotone"
                dataKey="margin"
                stroke="#3B82F6"
                strokeWidth={2}
                fill="url(#margin-fill)"
                name="Margin / pull"
              />
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#0F172A"
                strokeWidth={2}
                fill="url(#cost-fill)"
                name="Cost / pull"
              />
              <ReferenceLine
                x={breakpoint}
                stroke="#94A3B8"
                strokeDasharray="4 4"
                label={{ value: 'Breakpoint', fill: '#475569', fontSize: 11, position: 'top' }}
              />
              <ReferenceLine
                x={collective}
                stroke="#0F172A"
                strokeWidth={1.5}
                label={{ value: 'Now', fill: '#0F172A', fontSize: 11, position: 'top' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      {/* Daily usage per partner */}
      <SectionCard
        title="Daily usage per partner"
        subtitle="every day · every partner · what we made off each pull"
        bodyClassName="p-0"
        collapsible
        defaultOpen
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Period</th>
                <th>Partner</th>
                <th className="text-right">Pulls</th>
                <th className="text-right">Cost / pull</th>
                <th className="text-right">Charge / pull</th>
                <th className="text-right">Margin / pull</th>
                <th className="text-right">Revenue</th>
                <th>Margin share</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.slice(0, 80).map((r) => (
                <tr key={`${r.periodStart}-${r.partnerId}`}>
                  <td className="numeric text-muted">
                    {new Date(r.periodStart).toLocaleDateString('en-AU')}
                  </td>
                  <td className="numeric">
                    <span className="tag">{r.partnerId.slice(0, 8)}</span>
                  </td>
                  <td className="numeric text-right text-ink">{r.pulls.toLocaleString('en-AU')}</td>
                  <td className="numeric text-right text-ink2">
                    ${Number(r.costPerPull).toFixed(2)}
                  </td>
                  <td className="numeric text-right text-ink2">
                    ${Number(r.chargePerPull).toFixed(2)}
                  </td>
                  <td className="numeric text-right text-success font-medium">
                    ${Number(r.profitPerPull).toFixed(2)}
                  </td>
                  <td className="numeric text-right text-ink font-medium">
                    {formatMoney(r.totalRevenue)}
                  </td>
                  <td className="w-32">
                    <MiniBar value={Number(r.totalRevenue) / tableMax} />
                  </td>
                </tr>
              ))}
              {usageRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted py-8 text-center">
                    No HighSale usage yet.
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
