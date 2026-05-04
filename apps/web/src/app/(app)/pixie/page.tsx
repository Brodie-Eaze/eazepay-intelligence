'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';

interface PixieBP { collectiveLast24h: number; threshold: number; aboveBreakpoint: boolean }
interface PixieMargin { windowDays: number; totalMargin: string; totalPulls: number }
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

export default function PixiePage(): JSX.Element {
  const bp = useQuery({ queryKey: ['pixie.bp'], queryFn: () => api<PixieBP>('/pixie/breakpoint-status') });
  const margin = useQuery({ queryKey: ['pixie.margin'], queryFn: () => api<PixieMargin>('/pixie/margin') });
  const usage = useQuery({ queryKey: ['pixie.usage'], queryFn: () => api<PixieRow[]>('/pixie/usage?period=DAILY') });

  return (
    <div className="space-y-6">
      <PageHeader title="Pixie usage" subtitle="HighSale pre-qual · sliding-scale margin · margin / partner / day" />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Pulls (24h)"
          value={formatNumber(bp.data?.collectiveLast24h ?? 0)}
          hint={bp.data ? `${formatNumber(bp.data.threshold)} breakpoint` : '…'}
        />
        <KpiCard
          label="Above breakpoint?"
          value={bp.data ? (bp.data.aboveBreakpoint ? 'Yes' : 'No') : '…'}
          hint={bp.data?.aboveBreakpoint ? '$2.00 margin / pull' : 'subsidised — sliding'}
        />
        <KpiCard label="30-day margin" value={formatMoney(margin.data?.totalMargin ?? 0)} hint="all partners · all days" />
        <KpiCard label="30-day pulls" value={formatNumber(margin.data?.totalPulls ?? 0)} hint="collective volume" />
      </div>

      <SectionCard title="Daily margin per partner" subtitle="last 365 days available · scroll for more" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Period start</th>
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
              {(usage.data ?? []).slice(0, 50).map((r) => {
                const max = Math.max(1, ...(usage.data ?? []).map((x) => Number(x.totalRevenue)));
                return (
                  <tr key={`${r.periodStart}-${r.partnerId}`}>
                    <td className="numeric text-muted">{new Date(r.periodStart).toLocaleDateString('en-AU')}</td>
                    <td className="numeric"><code className="kbd">{r.partnerId.slice(0, 8)}</code></td>
                    <td className="numeric text-right text-ink">{r.pulls.toLocaleString('en-AU')}</td>
                    <td className="numeric text-right text-ink2">${Number(r.costPerPull).toFixed(2)}</td>
                    <td className="numeric text-right text-ink2">${Number(r.chargePerPull).toFixed(2)}</td>
                    <td className="numeric text-right text-success font-medium">${Number(r.profitPerPull).toFixed(2)}</td>
                    <td className="numeric text-right text-ink font-medium">{formatMoney(r.totalRevenue)}</td>
                    <td className="w-32"><MiniBar value={Number(r.totalRevenue) / max} tone="success" /></td>
                  </tr>
                );
              })}
              {(usage.data ?? []).length === 0 && <tr><td colSpan={8} className="text-center text-muted py-8">No Pixie usage yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
