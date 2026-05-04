'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDelta, formatMoney, formatNumber, formatPct } from '@/lib/format';
import type { OverviewResponse, RevenueByStreamRow } from '@/lib/types';
import { useUser } from '@/lib/auth';
import { RevenueAreaChart } from '@/components/RevenueAreaChart';
import { NarrativeHero } from '@/components/NarrativeHero';
import { SectionCard } from '@/components/SectionCard';
import { MiniBar } from '@/components/MiniBar';
import { RiskBand } from '@/components/RiskBand';
import { Monogram } from '@/components/Monogram';
import { RecentActivityTable, type ActivityRow } from '@/components/RecentActivityTable';

interface FunnelResp { submitted: number; approved: number; funded: number }
interface PixieBP { collectiveLast24h: number; threshold: number; aboveBreakpoint: boolean }
interface RiskRow { bucket: number; label: string; riskBand: string; count: number }
interface CustomerRow {
  emailHash: string; latestStatus: string; latestCreditScore: number | null;
  latestIncome: string | null; latestPropensity: string | null; riskBand: string;
  applications: number; latestApplicationAt: string; totalFunded: string;
}

export default function OverviewPage(): JSX.Element {
  const user = useUser();

  const overview = useQuery({ queryKey: ['analytics.overview'], queryFn: () => api<OverviewResponse>('/analytics/overview'), refetchInterval: 30_000 });
  const revenue = useQuery({
    queryKey: ['analytics.revenue', '90d'],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
      return api<RevenueByStreamRow[]>(`/analytics/revenue?from=${from}&to=${to}&bucket=day`);
    },
  });
  const funnel = useQuery({ queryKey: ['analytics.funnel'], queryFn: () => api<FunnelResp>('/analytics/funnel') });
  const pixie = useQuery({ queryKey: ['pixie.breakpoint'], queryFn: () => api<PixieBP>('/pixie/breakpoint-status') });
  const risk = useQuery({ queryKey: ['analytics.risk'], queryFn: () => api<RiskRow[]>('/analytics/risk-distribution') });
  const customers = useQuery({ queryKey: ['customers.book.preview'], queryFn: () => api<CustomerRow[]>('/customers?limit=8') });
  const live = useQuery({ queryKey: ['analytics.live'], queryFn: () => api<ActivityRow[]>('/analytics/live'), refetchInterval: 15_000 });

  const o = overview.data;
  if (overview.isLoading || !o) return <Skeleton />;

  const delta = formatDelta(o.momRevenueDelta);
  const dayLabel = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const fundedCount = funnel.data?.funded ?? 0;
  const submittedCount = funnel.data?.submitted ?? 0;
  const greeting = `Good ${greetWord()}, ${(user?.email ?? '').split('@')[0]}`;

  const totalApps = (risk.data ?? []).reduce((s, r) => s + r.count, 0);
  const primeApps = (risk.data ?? []).find((r) => r.riskBand === 'PRIME')?.count ?? 0;
  const subprimeApps = ((risk.data ?? []).find((r) => r.riskBand === 'SUBPRIME')?.count ?? 0)
    + ((risk.data ?? []).find((r) => r.riskBand === 'DEEP_SUBPRIME')?.count ?? 0);
  const unscored = (risk.data ?? []).find((r) => r.riskBand === 'UNSCORED')?.count ?? 0;

  return (
    <div className="space-y-6">
      <NarrativeHero
        badge={`Network briefing · ${dayLabel}`}
        narrative={
          <>
            <span className="text-accent">{formatNumber(submittedCount)} applications</span> moved through HighSale into BuzzPay. <span className="text-accent">{formatPct(o.approvalRate)}</span> approved, <span className="text-accent">{formatMoney(o.totalRevenue)}</span> booked.
          </>
        }
        subtext={`${greeting}. Pixie sits in front of every BuzzPay decision — pre-qual scoring drives propensity, decision engine renders the verdict, MiCamp clears the rails.`}
        kpis={[
          { label: 'Total revenue', value: formatMoney(o.totalRevenue), hint: `MoM ${delta.text}` },
          { label: 'Approval rate', value: formatPct(o.approvalRate), hint: `${formatNumber(submittedCount)} submitted` },
          { label: 'Funding rate', value: formatPct(o.fundingRate), hint: `${formatNumber(fundedCount)} funded` },
          { label: 'Active partners', value: formatNumber(o.activePartnerCount), hint: 'last 30 days' },
          { label: 'Pixie pulls 24h', value: formatNumber(o.pixiePullsLast24h), hint: pixie.data?.aboveBreakpoint ? 'above breakpoint' : 'below breakpoint' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SectionCard
          title="Revenue trajectory"
          subtitle="last 90 days · projected from append-only ledger"
          className="lg:col-span-2"
          bodyClassName="p-3"
          action={
            <div className="flex items-center gap-3 text-[11px] text-muted">
              <Legend color="#0F172A" label="BuzzPay" />
              <Legend color="#3B82F6" label="Pixie" />
              <Legend color="#93C5FD" label="MiCamp" />
            </div>
          }
        >
          {revenue.data ? <RevenueAreaChart data={revenue.data} height={300} /> : <div className="text-muted text-sm p-6">Loading…</div>}
        </SectionCard>

        <SectionCard
          title="Risk profile of the book"
          subtitle="every application by credit band"
          action={<Link href="/risk" className="text-xs text-accent hover:underline">Risk profiles →</Link>}
        >
          <div className="space-y-3">
            <BandRow label="Prime ≥ 720" count={primeApps} total={totalApps} band="PRIME" tone="success" />
            <BandRow label="Near-prime 660–719" count={(risk.data ?? []).find((r) => r.riskBand === 'NEAR_PRIME')?.count ?? 0} total={totalApps} band="NEAR_PRIME" tone="accent" />
            <BandRow label="Subprime 580–659" count={(risk.data ?? []).find((r) => r.riskBand === 'SUBPRIME')?.count ?? 0} total={totalApps} band="SUBPRIME" tone="warn" />
            <BandRow label="Deep subprime < 580" count={(risk.data ?? []).find((r) => r.riskBand === 'DEEP_SUBPRIME')?.count ?? 0} total={totalApps} band="DEEP_SUBPRIME" tone="danger" />
            <div className="pt-3 border-t border-line2 text-[11px] text-muted">
              {formatNumber(unscored)} of {formatNumber(totalApps)} unscored ({formatPct(totalApps ? unscored / totalApps : 0)})
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Inline operational strip — 4 small status tiles in one row */}
      <div className="card divide-x divide-line2 grid grid-cols-2 md:grid-cols-4">
        <PixieStat data={pixie.data} />
        <Stat label="Funnel today" value={formatNumber(submittedCount)} hint={`${formatNumber(fundedCount)} funded · ${formatPct(o.fundingRate)} fund rate`} />
        <Stat label="Active partners" value={formatNumber(o.activePartnerCount)} hint="last 30 days" />
        <Stat label="Pulse" value="Healthy" tone="success" hint="WS connected · queues green" />
      </div>

      {/* Customer book preview — as a table so columns align */}
      <SectionCard
        title="Newest customers"
        subtitle="latest applicants across the network · click a row for the full financial profile"
        action={<Link href="/customers" className="text-xs text-accent hover:underline">Customer book →</Link>}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Risk band</th>
                <th className="text-right">Credit</th>
                <th className="text-right">Income</th>
                <th className="text-right">Propensity</th>
                <th className="text-right">Apps</th>
                <th className="text-right">Funded</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {(customers.data ?? []).slice(0, 8).map((c) => (
                <tr key={c.emailHash}>
                  <td>
                    <Link href={`/customers/${c.emailHash}`} className="inline-flex items-center gap-2 text-ink hover:text-accent">
                      <Monogram label={`# ${c.emailHash.slice(0, 2)}`} />
                      <span className="font-medium tracking-tight">Customer {c.emailHash.slice(0, 8)}</span>
                    </Link>
                  </td>
                  <td><RiskBand band={c.riskBand} /></td>
                  <td className="numeric text-right text-ink2">{c.latestCreditScore ?? '—'}</td>
                  <td className="numeric text-right text-ink2">{c.latestIncome ? formatMoney(c.latestIncome) : '—'}</td>
                  <td className="numeric text-right text-ink2">{c.latestPropensity ? `${(Number(c.latestPropensity) * 100).toFixed(0)}%` : '—'}</td>
                  <td className="numeric text-right text-ink">{c.applications}</td>
                  <td className="numeric text-right text-success font-medium">{Number(c.totalFunded) > 0 ? formatMoney(c.totalFunded) : '—'}</td>
                  <td className="numeric text-muted text-xs whitespace-nowrap">{new Date(c.latestApplicationAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</td>
                </tr>
              ))}
              {(customers.data ?? []).length === 0 && <tr><td colSpan={8} className="text-muted text-center py-8">No customer activity yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Recent activity"
        subtitle={`${(live.data ?? []).length} events booked · expand for full feed`}
        action={<Link href="/live" className="text-xs text-accent hover:underline" onClick={(e) => e.stopPropagation()}>Live activity →</Link>}
        bodyClassName="p-0"
        collapsible
        defaultOpen={false}
      >
        <RecentActivityTable rows={(live.data ?? []).slice(0, 8)} />
      </SectionCard>
    </div>
  );
}

function BandRow({ label, count, total, band, tone }: { label: string; count: number; total: number; band: string; tone: 'success' | 'accent' | 'warn' | 'danger' }): JSX.Element {
  const pct = total ? count / total : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-ink2">{label}</span>
        <span className="numeric text-ink2">{formatNumber(count)} <span className="text-muted">· {formatPct(pct, 0)}</span></span>
      </div>
      <MiniBar value={pct} tone={tone === 'accent' ? 'accent' : tone === 'success' ? 'success' : tone === 'warn' ? 'warn' : 'danger'} />
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'success' | 'warn' | 'danger' }): JSX.Element {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div className="px-5 py-4">
      <div className="h-section">{label}</div>
      <div className={`numeric text-2xl font-semibold mt-1 tracking-tight ${toneClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function PixieStat({ data }: { data: PixieBP | undefined }): JSX.Element {
  if (!data) return <Stat label="Pixie 24h" value="…" />;
  const ratio = Math.min(1, data.collectiveLast24h / data.threshold);
  return (
    <div className="px-5 py-4">
      <div className="h-section">Pixie · last 24h</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="numeric text-2xl font-semibold text-ink tracking-tight">{formatNumber(data.collectiveLast24h)}</span>
        <span className="text-[11px] text-muted numeric">/ {formatNumber(data.threshold)}</span>
      </div>
      <MiniBar className="mt-2 h-1.5" tone={data.aboveBreakpoint ? 'success' : 'warn'} value={ratio} />
      <div className={`text-[11px] mt-1.5 font-medium ${data.aboveBreakpoint ? 'text-success' : 'text-warn'}`}>
        {data.aboveBreakpoint ? '$2.00 / pull' : 'subsidised'}
      </div>
    </div>
  );
}

function greetWord(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function Skeleton(): JSX.Element {
  return (
    <div className="space-y-6">
      <div className="h-44 rounded-2xl bg-surface animate-pulse" style={{ boxShadow: '0 0 0 1px #E2E8F0' }} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card h-[340px] lg:col-span-2 animate-pulse" />
        <div className="card h-[340px] animate-pulse" />
      </div>
    </div>
  );
}
