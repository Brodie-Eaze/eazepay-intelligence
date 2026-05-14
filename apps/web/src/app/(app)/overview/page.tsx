'use client';

import { useContext } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, formatPct } from '@/lib/format';
import type { OverviewResponse } from '@/lib/types';
import { useUser } from '@/lib/auth';
import { CountUp } from '@/components/CountUp';
import { WarehouseLandscape } from '@/components/WarehouseLandscape';
import { DataFlowDiagram } from '@/components/DataFlowDiagram';
import { LiveTickerContext } from '@/components/LiveTickerContext';
import { LiveTicker } from '@/components/LiveTicker';

interface FunnelResp {
  submitted: number;
  approved: number;
  funded: number;
}

/**
 * Overview — mission-control for the data warehouse.
 *
 * Four bands, top to bottom:
 *   1. HERO — the headline number animates in. Big, gradient, alive.
 *   2. WAREHOUSE LANDSCAPE — every table at a glance, row counts +
 *      freshness pulses. This is what makes it FEEL like a warehouse.
 *   3. DATA FLOW — sources → core → marts diagram with live numbers.
 *   4. LIVE TICKER — recent events streaming in.
 *
 * Nothing on this page is read-only-card-with-a-number; every block
 * answers a real question ("where's my data, how much, how fresh, what
 * just happened").
 */
export default function OverviewPage(): JSX.Element {
  const user = useUser();
  const { events } = useContext(LiveTickerContext);

  const overview = useQuery({
    queryKey: ['analytics.overview'],
    queryFn: () => api<OverviewResponse>('/analytics/overview'),
    refetchInterval: 30_000,
  });

  const funnel = useQuery({
    queryKey: ['analytics.funnel'],
    queryFn: () => api<FunnelResp>('/analytics/funnel'),
    refetchInterval: 30_000,
  });

  const o = overview.data;
  const f = funnel.data;
  const isLoaded = !!o;

  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const hour = new Date().getHours();
  const greeting =
    hour < 5
      ? 'Burning late'
      : hour < 12
        ? 'Good morning'
        : hour < 18
          ? 'Good afternoon'
          : 'Good evening';
  const userName = user?.email?.split('@')[0] ?? '';

  return (
    <div className="space-y-7">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border border-line2 bg-gradient-to-br from-[#0B1220] via-[#111d34] to-[#0F172A] text-surface px-7 lg:px-10 py-9 lg:py-11">
        {/* ambient grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        {/* gradient blob */}
        <div
          className="absolute -right-32 -top-32 w-[420px] h-[420px] rounded-full opacity-30 pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(96,165,250,0.7) 0%, rgba(96,165,250,0) 70%)',
          }}
        />

        <div className="relative">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-blue-300/70 mb-3">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Holdco data warehouse · live</span>
            <span className="text-blue-300/40">·</span>
            <span>{today}</span>
          </div>

          <h1 className="text-[14px] text-blue-100/70 font-medium mb-2">
            {greeting}
            {userName && <span className="text-blue-200">, {userName}</span>}.
          </h1>

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 mb-7">
            <div>
              <div className="text-[11px] text-blue-200/60 uppercase tracking-wider mb-1">
                Total revenue · this period
              </div>
              {isLoaded ? (
                <CountUp
                  value={Number(o.totalRevenue)}
                  formatter={(n) => formatMoney(n)}
                  className="text-[44px] lg:text-[56px] font-semibold tracking-tighter tabular-nums text-surface bg-gradient-to-r from-white via-white to-blue-200 bg-clip-text text-transparent"
                />
              ) : (
                <div className="text-[44px] lg:text-[56px] font-semibold tracking-tighter text-blue-200/30 numeric">
                  AUD …
                </div>
              )}
            </div>
            {isLoaded && o.momRevenueDelta != null && (
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`text-[14px] font-medium numeric ${
                    Number(o.momRevenueDelta) >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                >
                  {Number(o.momRevenueDelta) >= 0 ? '▲' : '▼'}{' '}
                  {formatPct(Math.abs(Number(o.momRevenueDelta)))}
                </span>
                <span className="text-[12px] text-blue-200/50">vs last month</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-x-8 gap-y-4">
            <HeroStat
              label="Applications"
              value={f?.submitted}
              hint={f ? `${formatPct(f.approved / Math.max(1, f.submitted))} approved` : '—'}
            />
            <HeroStat label="Funded" value={f?.funded} hint="loans booked" />
            <HeroStat
              label="Approval rate"
              value={isLoaded ? Number(o.approvalRate) : null}
              format="pct"
              hint={o ? `${formatNumber(o.activePartnerCount)} active partners` : '—'}
            />
            <HeroStat
              label="Pixie pulls · 24h"
              value={o?.pixiePullsLast24h ?? 0}
              hint="HighSale enrichments"
            />
            <HeroStat
              label="MoM revenue"
              value={isLoaded ? Number(o.momRevenueDelta) : null}
              format="pct-delta"
              hint="month-over-month"
            />
          </div>
        </div>
      </section>

      {/* ── WAREHOUSE LANDSCAPE ──────────────────────────────────────────── */}
      <WarehouseLandscape />

      {/* ── DATA FLOW + LIVE TICKER ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.7fr_1fr] gap-5">
        <DataFlowDiagram />
        <div className="rounded-xl border border-line2 bg-surface overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-line2 flex items-center justify-between">
            <div>
              <h2 className="text-ink font-semibold tracking-tight">Recent events</h2>
              <p className="text-[11px] text-muted mt-0.5">streaming from every plane</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-emerald-600 flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          </div>
          <div className="flex-1 min-h-[400px]">
            <LiveTicker events={events} />
          </div>
        </div>
      </div>

      {/* ── DEEP-LINK STRIP ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <DeepLink href="/portfolio" label="Holdco rollup" hint="7 launch businesses" />
        <DeepLink href="/data-sources" label="Data sources" hint="ingestion health" />
        <DeepLink href="/customers" label="Customer book" hint="every applicant" />
        <DeepLink href="/revenue" label="Revenue ledger" hint="append-only" />
      </div>
    </div>
  );
}

function HeroStat({
  label,
  value,
  hint,
  format,
}: {
  label: string;
  value: number | null | undefined;
  hint?: string;
  format?: 'money' | 'pct' | 'pct-delta' | 'number';
}): JSX.Element {
  const fmt = format ?? 'number';
  const display =
    value == null
      ? '…'
      : fmt === 'money'
        ? formatMoney(value)
        : fmt === 'pct'
          ? formatPct(value)
          : fmt === 'pct-delta'
            ? `${value >= 0 ? '+' : ''}${formatPct(value)}`
            : formatNumber(value);
  const positiveTrend = fmt === 'pct-delta' && value != null && value >= 0;
  const negativeTrend = fmt === 'pct-delta' && value != null && value < 0;

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-blue-200/50 mb-1">{label}</div>
      <div
        className={`text-[22px] lg:text-[26px] font-semibold tracking-tight tabular-nums numeric ${
          positiveTrend ? 'text-emerald-300' : negativeTrend ? 'text-rose-300' : 'text-surface'
        }`}
      >
        {display}
      </div>
      {hint && <div className="text-[11px] text-blue-200/50 mt-0.5">{hint}</div>}
    </div>
  );
}

function DeepLink({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="block px-4 py-3 rounded-lg border border-line2 bg-surface hover:border-accent hover:bg-paper transition group"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-medium text-ink tracking-tight">{label}</div>
          <div className="text-[10px] text-muted mt-0.5">{hint}</div>
        </div>
        <span className="text-accent opacity-0 group-hover:opacity-100 transition">→</span>
      </div>
    </Link>
  );
}
