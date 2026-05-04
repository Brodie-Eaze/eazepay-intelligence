'use client';

import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface PixieBP { collectiveLast24h: number; threshold: number; aboveBreakpoint: boolean }

export default function PixiePricingPage(): JSX.Element {
  const bp = useQuery({ queryKey: ['pixie.bp'], queryFn: () => api<PixieBP>('/pixie/breakpoint-status') });

  // Simulate the curve: 0..2x breakpoint with cost & margin per pull
  const breakpoint = bp.data?.threshold ?? 25_000;
  const baseCost = 1.0;
  const baseCharge = 3.0;
  const curve = Array.from({ length: 41 }).map((_, i) => {
    const collective = Math.round((breakpoint * 2 * i) / 40);
    const cost = collective >= breakpoint ? baseCost : baseCost * (2 - collective / breakpoint);
    const margin = baseCharge - cost;
    return { collective, cost: Number(cost.toFixed(2)), margin: Number(margin.toFixed(2)) };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pixie · pricing model"
        subtitle="Sliding-scale cost-per-pull · margin saturates at the breakpoint"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Breakpoint" value={formatNumber(breakpoint)} hint="collective pulls / day" />
        <KpiCard label="Cost @ breakpoint" value={`$${baseCost.toFixed(2)}`} hint="per pull" />
        <KpiCard label="Charge to partner" value={`$${baseCharge.toFixed(2)}`} hint="per pull (fixed)" />
        <KpiCard label="Max margin" value={`$${(baseCharge - baseCost).toFixed(2)}`} hint="per pull above breakpoint" />
      </div>

      <SectionCard title="Margin curve" subtitle="x-axis: collective daily pulls · y-axis: $ per pull · vertical line marks breakpoint" bodyClassName="p-3">
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
              <CartesianGrid stroke="#E5E7EB" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="collective" stroke="#94A3B8" fontSize={11} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12 }}
                formatter={(v: number, name: string) => [`$${v.toFixed(2)}`, name]}
                labelFormatter={(v) => `${formatNumber(Number(v))} collective pulls`}
              />
              <Area type="monotone" dataKey="margin" stroke="#3B82F6" strokeWidth={2} fill="url(#margin-fill)" name="Margin" />
              <Area type="monotone" dataKey="cost" stroke="#0F172A" strokeWidth={2} fill="url(#cost-fill)" name="Cost" />
              <ReferenceLine x={breakpoint} stroke="#94A3B8" strokeDasharray="4 4" label={{ value: 'Breakpoint', fill: '#475569', fontSize: 11, position: 'top' }} />
              {bp.data && (
                <ReferenceLine x={bp.data.collectiveLast24h} stroke="#0F172A" strokeWidth={1.5} label={{ value: 'Now', fill: '#0F172A', fontSize: 11, position: 'top' }} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="How it works" bodyClassName="p-5">
        <div className="text-sm text-ink2 leading-relaxed space-y-2">
          <p>Below {formatNumber(breakpoint)} collective daily pulls, our cost is subsidised — it slides linearly from <code className="kbd">2 × ${baseCost.toFixed(2)}</code> at zero volume down to <code className="kbd">${baseCost.toFixed(2)}</code> at the breakpoint. Charge to the partner stays at <code className="kbd">${baseCharge.toFixed(2)}</code> regardless.</p>
          <p>Above the breakpoint we capture full <code className="kbd">${(baseCharge - baseCost).toFixed(2)}</code> margin per pull. Investor reporting projects margin per partner per day from the <code className="kbd">PixieMetric</code> hypertable.</p>
        </div>
      </SectionCard>
    </div>
  );
}
