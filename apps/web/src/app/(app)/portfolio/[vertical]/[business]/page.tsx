'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { StatusPill } from '@/components/StatusPill';

interface Business {
  slug: string;
  name: string;
  vertical: string;
  status: string;
  acquiredAt: string;
  ownershipPct: number;
  hqRegion: string;
  segment: string;
  fteCount: number;
  ttmRevenue: number;
  ttmEbitda: number;
  ttmGrossProfit: number;
  arr: number;
  nrr: number;
  grossMargin: number;
  cashOnHand: number;
  netDebt: number;
}

interface FinancialPeriod {
  periodStart: string;
  periodLabel: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marketingSpend: number;
  payroll: number;
  rentAndUtilities: number;
  softwareAndTools: number;
  professionalServices: number;
  otherOpex: number;
  ebitda: number;
  depreciation: number;
  interest: number;
  tax: number;
  netIncome: number;
  cashIn: number;
  cashOut: number;
  arBalance: number;
  apBalance: number;
}

interface RevenueChannel {
  channel: string;
  revenue: number;
  customers: number;
  share: number;
}
interface ProductLine {
  name: string;
  revenue: number;
  units: number;
  avgPrice: number;
}
interface UnitEconomics {
  cac: number;
  ltv: number;
  paybackMonths: number;
  arpu: number;
  grossMargin: number;
  nrr: number;
  churnMonthly: number;
}
interface HeadcountRow {
  function: string;
  ftes: number;
  payrollMonthly: number;
  openRoles: number;
}

export default function BusinessDeepDive(): JSX.Element {
  const { vertical, business } = useParams<{ vertical: string; business: string }>();

  const overview = useQuery({
    queryKey: ['portfolio.business', business],
    queryFn: () =>
      api<{ business: Business; vertical: { slug: string; name: string; description: string } }>(
        `/portfolio/businesses/${business}`,
      ),
    enabled: Boolean(business),
  });
  const pnl = useQuery({
    queryKey: ['portfolio.pnl', business],
    queryFn: () => api<{ periods: FinancialPeriod[] }>(`/portfolio/businesses/${business}/pnl`),
    enabled: Boolean(business),
  });
  const revenue = useQuery({
    queryKey: ['portfolio.revenue', business],
    queryFn: () =>
      api<{ channels: RevenueChannel[]; products: ProductLine[] }>(
        `/portfolio/businesses/${business}/revenue`,
      ),
    enabled: Boolean(business),
  });
  const ue = useQuery({
    queryKey: ['portfolio.ue', business],
    queryFn: () => api<UnitEconomics>(`/portfolio/businesses/${business}/unit-economics`),
    enabled: Boolean(business),
  });
  const headcount = useQuery({
    queryKey: ['portfolio.headcount', business],
    queryFn: () => api<{ rows: HeadcountRow[] }>(`/portfolio/businesses/${business}/headcount`),
    enabled: Boolean(business),
  });

  const b = overview.data?.business;
  const v = overview.data?.vertical;
  const periods = pnl.data?.periods ?? [];
  const last = periods[periods.length - 1];
  const prev = periods[periods.length - 13]; // YoY

  // Trim periods to last 12 for chart density
  const last12 = periods.slice(-12);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Link href="/portfolio" className="hover:text-ink">
          Portfolio
        </Link>
        <ChevronRight size={12} />
        <Link href={`/portfolio/${vertical}`} className="hover:text-ink">
          {v?.name ?? vertical}
        </Link>
        <ChevronRight size={12} />
        <span className="text-ink">{b?.name ?? business}</span>
      </div>

      <PageHeader
        title={b?.name ?? '…'}
        subtitle={
          b ? `${b.segment} · ${b.hqRegion} · founded ${b.acquiredAt}` : 'Loading business…'
        }
        action={b ? <StatusPill>{b.status}</StatusPill> : undefined}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="TTM revenue"
          value={b ? formatMoney(b.ttmRevenue) : '…'}
          hint={
            last && prev
              ? `${formatPct((last.revenue - prev.revenue) / Math.max(1, prev.revenue))} YoY`
              : ''
          }
        />
        <KpiCard
          label="TTM EBITDA"
          value={b ? formatMoney(b.ttmEbitda) : '…'}
          hint={b ? `${formatPct(b.ttmRevenue ? b.ttmEbitda / b.ttmRevenue : 0)} margin` : ''}
        />
        <KpiCard
          label="Gross margin"
          value={b ? formatPct(b.grossMargin) : '…'}
          hint={b ? `${formatMoney(b.ttmGrossProfit)} TTM` : ''}
        />
        <KpiCard
          label="Cash · net debt"
          value={b ? formatMoney(b.cashOnHand) : '…'}
          hint={
            b && b.netDebt < 0
              ? `${formatMoney(Math.abs(b.netDebt))} net cash`
              : b
                ? `${formatMoney(b.netDebt)} net debt`
                : ''
          }
        />
      </div>

      <SectionCard title="Silo profile" subtitle="ownership, segment, scale" bodyClassName="p-0">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 divide-x divide-line2">
          <Cell label="Vertical" value={v?.name ?? '—'} />
          <Cell label="Status" value={b?.status ?? '—'} />
          <Cell label="Ownership" value={b ? formatPct(b.ownershipPct, 0) : '—'} />
          <Cell label="HQ" value={b?.hqRegion ?? '—'} />
          <Cell label="FTEs" value={b ? formatNumber(b.fteCount) : '—'} />
          <Cell
            label="ARR"
            value={b && b.arr > 0 ? formatMoney(b.arr) : 'n/a'}
            hint={b && b.arr > 0 ? `NRR ${formatPct(b.nrr)}` : 'transactional'}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Revenue & EBITDA · last 12 months"
        subtitle="bars are revenue · the line is EBITDA · trailing operating profile"
        bodyClassName="p-3"
      >
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={last12} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="periodLabel" stroke="#94A3B8" fontSize={11} />
              <YAxis
                yAxisId="left"
                stroke="#94A3B8"
                fontSize={11}
                tickFormatter={(v: number) => compactMoney(v)}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#94A3B8"
                fontSize={11}
                tickFormatter={(v: number) => compactMoney(v)}
              />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) => [formatMoney(v), label(name)]}
              />
              <Bar yAxisId="left" dataKey="revenue" fill="#1D4ED8" radius={[4, 4, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="ebitda"
                stroke="#0F172A"
                strokeWidth={2}
                dot={{ r: 3, fill: '#0F172A' }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard
        title="Cash flow · last 12 months"
        subtitle="cash-in vs cash-out, monthly"
        bodyClassName="p-3"
      >
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={last12} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="periodLabel" stroke="#94A3B8" fontSize={11} />
              <YAxis
                stroke="#94A3B8"
                fontSize={11}
                tickFormatter={(v: number) => compactMoney(v)}
              />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) => [formatMoney(v), label(name)]}
              />
              <Area
                type="monotone"
                dataKey="cashIn"
                stroke="#1D4ED8"
                fill="#1D4ED8"
                fillOpacity={0.18}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="cashOut"
                stroke="#0F172A"
                fill="#0F172A"
                fillOpacity={0.1}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard
        title="P&L · monthly waterfall"
        subtitle="full income statement · last 12 months · bottom line is net income"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="sticky left-0 bg-surface z-10">Line item</th>
                {last12.map((p) => (
                  <th key={p.periodStart} className="text-right whitespace-nowrap">
                    {p.periodLabel}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <PnlRow label="Revenue" tone="header" rows={last12} pick={(p) => p.revenue} />
              <PnlRow label="COGS" rows={last12} pick={(p) => -p.cogs} />
              <PnlRow
                label="Gross profit"
                tone="subtotal"
                rows={last12}
                pick={(p) => p.grossProfit}
              />
              <PnlRow label="Marketing" rows={last12} pick={(p) => -p.marketingSpend} />
              <PnlRow label="Payroll" rows={last12} pick={(p) => -p.payroll} />
              <PnlRow label="Rent & utilities" rows={last12} pick={(p) => -p.rentAndUtilities} />
              <PnlRow label="Software" rows={last12} pick={(p) => -p.softwareAndTools} />
              <PnlRow
                label="Professional services"
                rows={last12}
                pick={(p) => -p.professionalServices}
              />
              <PnlRow label="Other opex" rows={last12} pick={(p) => -p.otherOpex} />
              <PnlRow label="EBITDA" tone="subtotal" rows={last12} pick={(p) => p.ebitda} />
              <PnlRow label="Depreciation" rows={last12} pick={(p) => -p.depreciation} />
              <PnlRow label="Interest" rows={last12} pick={(p) => -p.interest} />
              <PnlRow label="Tax" rows={last12} pick={(p) => -p.tax} />
              <PnlRow label="Net income" tone="total" rows={last12} pick={(p) => p.netIncome} />
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard
          title="Revenue by channel"
          subtitle="TTM · how the business acquires"
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Share</th>
                  <th className="text-right">Customers</th>
                </tr>
              </thead>
              <tbody>
                {(revenue.data?.channels ?? []).map((c) => (
                  <tr key={c.channel}>
                    <td className="text-ink font-medium">{c.channel}</td>
                    <td className="numeric text-right text-ink">{formatMoney(c.revenue)}</td>
                    <td className="numeric text-right text-ink2">{formatPct(c.share)}</td>
                    <td className="numeric text-right text-ink2">{formatNumber(c.customers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          title="Revenue by product line"
          subtitle="TTM · what the business sells"
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Avg price</th>
                </tr>
              </thead>
              <tbody>
                {(revenue.data?.products ?? []).map((p) => (
                  <tr key={p.name}>
                    <td className="text-ink font-medium">{p.name}</td>
                    <td className="numeric text-right text-ink">{formatMoney(p.revenue)}</td>
                    <td className="numeric text-right text-ink2">{formatNumber(p.units)}</td>
                    <td className="numeric text-right text-ink2">{formatMoney(p.avgPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Unit economics"
        subtitle="CAC, LTV, payback, retention"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 divide-x divide-line2">
          <Cell label="CAC" value={ue.data ? formatMoney(ue.data.cac) : '—'} hint="blended" />
          <Cell
            label="LTV"
            value={ue.data ? formatMoney(ue.data.ltv) : '—'}
            hint="gross-margin weighted"
          />
          <Cell
            label="LTV / CAC"
            value={ue.data ? `${(ue.data.ltv / ue.data.cac).toFixed(1)}×` : '—'}
            hint="≥3× is healthy"
          />
          <Cell
            label="Payback"
            value={ue.data ? `${ue.data.paybackMonths} mo` : '—'}
            hint="time to recoup CAC"
          />
          <Cell label="ARPU" value={ue.data ? formatMoney(ue.data.arpu) : '—'} hint="monthly" />
          <Cell
            label="NRR"
            value={ue.data ? formatPct(ue.data.nrr) : '—'}
            hint="net revenue retention"
          />
          <Cell
            label="Churn"
            value={ue.data ? formatPct(ue.data.churnMonthly) : '—'}
            hint="monthly logo churn"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Headcount by function"
        subtitle="FTE distribution · monthly payroll · open roles"
        bodyClassName="p-3"
      >
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={headcount.data?.rows ?? []}
              margin={{ top: 10, right: 16, bottom: 8, left: 8 }}
            >
              <CartesianGrid stroke="#EEF1F5" vertical={false} />
              <XAxis dataKey="function" stroke="#94A3B8" fontSize={11} />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: '#FFFFFF',
                  border: '1px solid #E2E8F0',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, name: string) =>
                  name === 'ftes' ? [v, 'FTEs'] : [formatMoney(v), 'Payroll']
                }
              />
              <Bar dataKey="ftes" fill="#1D4ED8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="overflow-x-auto mt-3">
          <table className="tbl">
            <thead>
              <tr>
                <th>Function</th>
                <th className="text-right">FTEs</th>
                <th className="text-right">Monthly payroll</th>
                <th className="text-right">Open roles</th>
              </tr>
            </thead>
            <tbody>
              {(headcount.data?.rows ?? []).map((h) => (
                <tr key={h.function}>
                  <td className="text-ink font-medium">{h.function}</td>
                  <td className="numeric text-right text-ink">{formatNumber(h.ftes)}</td>
                  <td className="numeric text-right text-ink2">{formatMoney(h.payrollMonthly)}</td>
                  <td className="numeric text-right text-ink2">{h.openRoles || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function PnlRow({
  label,
  rows,
  pick,
  tone,
}: {
  label: string;
  rows: FinancialPeriod[];
  pick: (p: FinancialPeriod) => number;
  tone?: 'header' | 'subtotal' | 'total';
}): JSX.Element {
  const cellTone =
    tone === 'header'
      ? 'text-ink font-semibold'
      : tone === 'subtotal'
        ? 'text-ink font-medium'
        : tone === 'total'
          ? 'text-ink font-semibold'
          : 'text-ink2';
  const rowBg = tone === 'subtotal' ? 'bg-surface2/50' : tone === 'total' ? 'bg-surface2' : '';
  return (
    <tr className={rowBg}>
      <td className={`sticky left-0 bg-surface z-10 ${cellTone}`}>{label}</td>
      {rows.map((p) => {
        const v = pick(p);
        return (
          <td key={p.periodStart} className={`numeric text-right whitespace-nowrap ${cellTone}`}>
            {v === 0 ? '—' : formatMoney(v)}
          </td>
        );
      })}
    </tr>
  );
}

function Cell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="px-5 py-4">
      <div className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">{label}</div>
      <div className="numeric text-[18px] font-semibold tracking-tight text-ink mt-1">{value}</div>
      {hint && <div className="text-[11px] text-muted mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}

function compactMoney(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function label(name: string): string {
  switch (name) {
    case 'revenue':
      return 'Revenue';
    case 'ebitda':
      return 'EBITDA';
    case 'cashIn':
      return 'Cash in';
    case 'cashOut':
      return 'Cash out';
    default:
      return name;
  }
}
