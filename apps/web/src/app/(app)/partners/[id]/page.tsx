'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, formatPct } from '@/lib/format';
import type { RevenueByStreamRow } from '@/lib/types';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { Monogram } from '@/components/Monogram';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';
import { RevenueAreaChart } from '@/components/RevenueAreaChart';

interface PerfResponse {
  partner: {
    id: string;
    name?: string;
    label?: string;
    tier: string;
    status: string;
    industry: string;
    onboardingDate?: string;
    contractValue?: string;
    pixieMargin?: string;
    pixieDataPullCost?: string;
    pixieChargeRate?: string;
    externalId?: string;
  };
  window: { from: string; to: string };
  metrics: { applications: number; decisions: number; fundings: number; revenueTotal: string };
}

interface AppRow {
  id: string;
  externalApplicationId: string;
  consumerNameMasked: string;
  consumerEmailMasked: string;
  status: string;
  creditScore: number | null;
  createdAt: string;
}

interface LedgerRow {
  idempotencyKey: string;
  partnerId: string;
  source: string;
  stream: string;
  eventType: string;
  amount: string;
  effectiveAt: string;
}

const TABS = ['Performance', 'Applications', 'Revenue ledger', 'Pixie usage', 'Audit'] as const;

export default function PartnerDetail({ params }: { params: { id: string } }): JSX.Element {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Performance');

  const perf = useQuery({
    queryKey: ['partner.performance', params.id],
    queryFn: () => api<PerfResponse>(`/partners/${params.id}/performance`),
  });
  const apps = useQuery({
    queryKey: ['partner.apps', params.id],
    queryFn: () => api<{ data: AppRow[] }>(`/applications?partnerId=${params.id}&limit=50`),
    enabled: tab === 'Applications',
  });
  const ledger = useQuery({
    queryKey: ['partner.ledger', params.id],
    queryFn: () => api<{ data: LedgerRow[] }>(`/revenue/ledger?partnerId=${params.id}&limit=100`),
    enabled: tab === 'Revenue ledger',
  });
  const revenueChart = useQuery({
    queryKey: ['partner.revenue.chart', params.id],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
      return api<RevenueByStreamRow[]>(`/analytics/revenue?from=${from}&to=${to}&bucket=day`);
    },
    enabled: tab === 'Performance',
  });

  if (perf.isLoading) return <div className="text-muted">Loading…</div>;
  if (!perf.data) return <div className="card card-pad text-danger">Partner not found.</div>;

  const p = perf.data.partner;
  const m = perf.data.metrics;
  const display = 'name' in p && p.name ? p.name : (p.label ?? '—');

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="card card-pad">
        <div className="flex items-center gap-4">
          <div className="!h-14 !w-14">
            <Monogram label={display} />
          </div>
          <div className="flex-1">
            <h1 className="text-ink text-2xl font-semibold tracking-tight">{display}</h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted flex-wrap">
              <span>{p.industry}</span>
              <span className="text-line">·</span>
              <StatusPill>{p.status}</StatusPill>
              {p.externalId && <span className="tag">{p.externalId}</span>}
              {p.onboardingDate && (
                <span className="text-muted">onboarded {formatDateTime(p.onboardingDate)}</span>
              )}
            </div>
          </div>
          <Link href="/partners" className="text-xs text-accent hover:underline">
            ← All partners
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Applications" value={formatNumber(m.applications)} hint="last 90 days" />
        <KpiCard
          label="Decisions"
          value={formatNumber(m.decisions)}
          hint={m.applications ? `${formatPct(m.decisions / m.applications)} of apps` : '—'}
        />
        <KpiCard
          label="Fundings"
          value={formatNumber(m.fundings)}
          hint={m.decisions ? `${formatPct(m.fundings / m.decisions)} of decisions` : '—'}
        />
        <KpiCard
          label="Revenue"
          value={formatMoney(m.revenueTotal)}
          hint="ledger projection · 90d"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition ${
              tab === t
                ? 'border-accent text-ink font-medium'
                : 'border-transparent text-muted hover:text-ink2'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Performance' && (
        <div className="space-y-6">
          <SectionCard
            title="Revenue over time"
            subtitle="last 90 days · all streams · partner-scoped projection coming v1.1"
            bodyClassName="p-3"
          >
            {revenueChart.data ? (
              <RevenueAreaChart data={revenueChart.data} height={260} />
            ) : (
              <div className="text-muted text-sm p-6">Loading…</div>
            )}
          </SectionCard>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <SectionCard title="Contract" subtitle="commercial terms">
              {p.contractValue && (
                <DetailRow
                  k="Contract value"
                  v={<span className="numeric">{formatMoney(p.contractValue)}</span>}
                />
              )}
              {p.pixieMargin && (
                <DetailRow
                  k="Pixie margin / pull"
                  v={<span className="numeric">${Number(p.pixieMargin).toFixed(2)}</span>}
                />
              )}
              {p.pixieDataPullCost && (
                <DetailRow
                  k="Pixie cost / pull"
                  v={<span className="numeric">${Number(p.pixieDataPullCost).toFixed(2)}</span>}
                />
              )}
              {p.pixieChargeRate && (
                <DetailRow
                  k="Pixie charge / pull"
                  v={<span className="numeric">${Number(p.pixieChargeRate).toFixed(2)}</span>}
                />
              )}
              <DetailRow k="Status" v={<StatusPill>{p.status}</StatusPill>} />
            </SectionCard>

            <SectionCard title="Window" subtitle="performance period">
              <DetailRow
                k="From"
                v={
                  <span className="numeric">
                    {new Date(perf.data.window.from).toLocaleDateString('en-AU')}
                  </span>
                }
              />
              <DetailRow
                k="To"
                v={
                  <span className="numeric">
                    {new Date(perf.data.window.to).toLocaleDateString('en-AU')}
                  </span>
                }
              />
              <DetailRow k="Span" v={<span className="numeric">90 days</span>} />
              {p.onboardingDate && (
                <DetailRow
                  k="Tenure"
                  v={
                    <span className="numeric">
                      {Math.floor((Date.now() - new Date(p.onboardingDate).getTime()) / 86_400_000)}{' '}
                      days
                    </span>
                  }
                />
              )}
            </SectionCard>

            <SectionCard title="Conversion (90d)" subtitle="this partner's funnel">
              <Stage label="Applications" v={m.applications} max={m.applications} tone="accent" />
              <Stage label="Decisions" v={m.decisions} max={m.applications} tone="accent" />
              <Stage label="Fundings" v={m.fundings} max={m.applications} tone="success" />
            </SectionCard>
          </div>
        </div>
      )}

      {tab === 'Applications' && (
        <SectionCard
          title={`${(apps.data?.data ?? []).length} most-recent applications`}
          subtitle="all states · click an ID to drill in"
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>External ID</th>
                  <th>Consumer</th>
                  <th>Email</th>
                  <th className="text-right">Credit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(apps.data?.data ?? []).map((a) => (
                  <tr key={a.id} className="cursor-pointer">
                    <td className="numeric text-muted whitespace-nowrap">
                      {formatDateTime(a.createdAt)}
                    </td>
                    <td>
                      <Link
                        href={`/applications/${a.id}`}
                        className="text-accent hover:underline numeric"
                      >
                        <code className="kbd">{a.externalApplicationId}</code>
                      </Link>
                    </td>
                    <td className="text-ink">{a.consumerNameMasked}</td>
                    <td className="text-muted">{a.consumerEmailMasked}</td>
                    <td className="numeric text-right text-ink2">{a.creditScore ?? '—'}</td>
                    <td>
                      <StatusPill>{a.status}</StatusPill>
                    </td>
                  </tr>
                ))}
                {(apps.data?.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-muted py-8 text-center">
                      No applications.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {tab === 'Revenue ledger' && (
        <SectionCard
          title="Ledger entries"
          subtitle="every dollar tied to this partner"
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Effective</th>
                  <th>Stream</th>
                  <th>Type</th>
                  <th>Idempotency key</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(ledger.data?.data ?? []).map((r) => {
                  const negative = Number(r.amount) < 0;
                  return (
                    <tr key={r.idempotencyKey}>
                      <td className="numeric text-muted whitespace-nowrap">
                        {formatDateTime(r.effectiveAt)}
                      </td>
                      <td>
                        <StatusPill>{r.stream}</StatusPill>
                      </td>
                      <td>
                        <StatusPill>{r.eventType}</StatusPill>
                      </td>
                      <td className="text-[11px] text-muted truncate max-w-[300px]">
                        <code>{r.idempotencyKey}</code>
                      </td>
                      <td
                        className={`numeric text-right font-medium ${negative ? 'text-danger' : 'text-success'}`}
                      >
                        {negative ? '−' : ''}
                        {formatMoney(Math.abs(Number(r.amount)))}
                      </td>
                    </tr>
                  );
                })}
                {(ledger.data?.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-muted py-8 text-center">
                      No revenue events for this partner.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {tab === 'Pixie usage' && <PixieTab partnerId={params.id} />}

      {tab === 'Audit' && <AuditTab partnerId={params.id} />}
    </div>
  );
}

function DetailRow({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2 border-b border-line/60 last:border-b-0 text-sm">
      <span className="text-muted">{k}</span>
      <span className="text-ink">{v}</span>
    </div>
  );
}

function Stage({
  label,
  v,
  max,
  tone,
}: {
  label: string;
  v: number;
  max: number;
  tone: 'accent' | 'success';
}): JSX.Element {
  return (
    <div className="py-2 border-b border-line/60 last:border-b-0">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="numeric text-ink font-medium">
          {formatNumber(v)}{' '}
          <span className="text-muted">· {((max ? v / max : 0) * 100).toFixed(0)}%</span>
        </span>
      </div>
      <MiniBar value={max ? v / max : 0} tone={tone} className="mt-1.5" />
    </div>
  );
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

function PixieTab({ partnerId }: { partnerId: string }): JSX.Element {
  const q = useQuery({
    queryKey: ['partner.pixie', partnerId],
    queryFn: () => api<PixieRow[]>(`/pixie/usage?partnerId=${partnerId}&period=DAILY`),
  });
  const rows = q.data ?? [];
  const totalPulls = rows.reduce((s, r) => s + r.pulls, 0);
  const totalRev = rows.reduce((s, r) => s + Number(r.totalRevenue), 0);
  const max = Math.max(1, ...rows.map((r) => Number(r.totalRevenue)));
  const days = rows.length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Days tracked" value={formatNumber(days)} hint="Pixie metric rows" />
        <KpiCard
          label="Total pulls"
          value={formatNumber(totalPulls)}
          hint={days ? `${Math.round(totalPulls / days)} avg/day` : ''}
        />
        <KpiCard label="Total margin" value={formatMoney(totalRev)} hint="EazePay revenue" />
      </div>
      <SectionCard
        title="Daily Pixie usage & margin"
        subtitle="this partner only · most recent first"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Period start</th>
                <th className="text-right">Pulls</th>
                <th className="text-right">Cost / pull</th>
                <th className="text-right">Charge / pull</th>
                <th className="text-right">Margin / pull</th>
                <th className="text-right">Revenue</th>
                <th>Margin share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.periodStart}-${r.partnerId}`}>
                  <td className="numeric text-muted">
                    {new Date(r.periodStart).toLocaleDateString('en-AU')}
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
                    <MiniBar value={Number(r.totalRevenue) / max} tone="success" />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted py-8 text-center">
                    No Pixie usage for this partner.
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

interface AuditRow {
  id: string;
  userEmail: string | null;
  userRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
}

function AuditTab({ partnerId }: { partnerId: string }): JSX.Element {
  const q = useQuery({
    queryKey: ['partner.audit', partnerId],
    queryFn: () => api<AuditRow[]>(`/audit-logs?resourceType=partner&limit=100`),
  });
  const rows = (q.data ?? []).filter((r) => r.resourceId === partnerId);

  return (
    <SectionCard
      title="Audit trail"
      subtitle={`${rows.length} mutation${rows.length === 1 ? '' : 's'} on this partner`}
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="numeric text-muted whitespace-nowrap">
                  {formatDateTime(r.createdAt)}
                </td>
                <td>
                  <span className="tag">{r.action}</span>
                </td>
                <td>
                  {r.userEmail ? (
                    <div>
                      <div className="text-ink text-sm">{r.userEmail}</div>
                      <div className="text-[11px] text-muted">{r.userRole}</div>
                    </div>
                  ) : (
                    <span className="text-muted text-sm">system</span>
                  )}
                </td>
                <td className="text-[11px] text-muted truncate max-w-[400px]">
                  <span className="tag">{JSON.stringify(r.metadata ?? {})}</span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted py-8 text-center">
                  No audit entries for this partner yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
