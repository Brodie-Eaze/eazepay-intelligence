'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { PulseDot } from './PulseDot';

interface IngestionStats {
  source: string;
  last24h: number;
  lastReceivedAt: string | null;
  status: 'HEALTHY' | 'STALE' | 'IDLE';
}

interface SourceNode {
  key: string;
  label: string;
  blurb: string;
  href: string;
}

const SOURCES: SourceNode[] = [
  {
    key: 'highsale',
    label: 'HighSale',
    blurb: 'credit-data per applicant',
    href: '/highsale',
  },
  { key: 'pixie', label: 'Pixie', blurb: 'pre-qual usage', href: '/pixie' },
  { key: 'micamp', label: 'MiCamp', blurb: 'processing + reversals', href: '/micamp' },
  { key: 'lenders', label: 'Lenders', blurb: 'funded loans + repayments', href: '/lenders' },
];

/**
 * Visual data-flow: four inbound planes funnelling into the warehouse
 * core, then fanning out to per-business marts. Looks like a data
 * warehouse the moment you see it.
 *
 * Each source node shows live ingestion stats + a freshness pulse.
 * The arrows + the central "warehouse core" tag tell the story even
 * to someone who's never seen the system before.
 */
export function DataFlowDiagram(): JSX.Element {
  const stats = useQuery({
    queryKey: ['data-sources.stats'],
    queryFn: () => api<{ data: IngestionStats[] }>('/data-sources/stats'),
    refetchInterval: 30_000,
    retry: false,
  });

  const byKey = new Map<string, IngestionStats>(
    (stats.data?.data ?? []).map((s) => [s.source.toLowerCase(), s]),
  );

  return (
    <div className="rounded-xl border border-line2 bg-surface overflow-hidden">
      <div className="px-5 py-4 border-b border-line2">
        <h2 className="text-ink font-semibold tracking-tight">Data flow · live</h2>
        <p className="text-[11px] text-muted mt-0.5">
          inbound planes feed the warehouse core · marts fan out to per-business analytics
        </p>
      </div>

      <div className="p-5 lg:p-7">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr] gap-x-5 gap-y-3 items-center">
          {/* ── Column 1: sources ─────────────────────────────────────── */}
          <div className="space-y-2.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted px-1 mb-1">
              Inbound planes
            </div>
            {SOURCES.map((s) => {
              const stat = byKey.get(s.key);
              const status = stat?.status ?? 'IDLE';
              return (
                <Link
                  key={s.key}
                  href={s.href}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-paper border border-line2 hover:border-accent transition group"
                >
                  <PulseDot status={status} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink tracking-tight">{s.label}</div>
                    <div className="text-[10px] text-muted truncate">{s.blurb}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[13px] numeric font-semibold text-ink tabular-nums">
                      {formatNumber(stat?.last24h ?? 0)}
                    </div>
                    <div className="text-[9px] uppercase tracking-wider text-muted">24h</div>
                  </div>
                </Link>
              );
            })}
          </div>

          {/* ── Arrow 1 ───────────────────────────────────────────────── */}
          <Arrow />

          {/* ── Column 2: core ──────────────────────────────────────── */}
          <div className="space-y-2.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted px-1 mb-1">
              Warehouse core
            </div>
            <CoreCard label="applications" note="application lifecycle" href="/applications" />
            <CoreCard label="credit_enrichments" note="70 fields per applicant" href="/highsale" />
            <CoreCard label="revenue_events" note="append-only ledger" href="/revenue/ledger" />
            <CoreCard label="webhook_events" note="raw inbound stream" href="/ops/webhooks" />
          </div>

          {/* ── Arrow 2 ───────────────────────────────────────────────── */}
          <Arrow />

          {/* ── Column 3: marts / consumers ─────────────────────────── */}
          <div className="space-y-2.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted px-1 mb-1">
              Marts · consumers
            </div>
            <MartCard
              label="Per-business revenue"
              note="7 launch businesses"
              href="/revenue/streams"
            />
            <MartCard label="Customer book" note="every applicant" href="/customers" />
            <MartCard label="Risk + propensity" note="HighSale calibration" href="/propensity" />
            <MartCard label="Holdco rollup" note="MTD / TTM across 7 orgs" href="/portfolio" />
          </div>
        </div>
      </div>
    </div>
  );
}

function CoreCard({
  label,
  note,
  href,
}: {
  label: string;
  note: string;
  href: string;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="block px-3 py-2.5 rounded-lg border border-dashed border-accent/40 bg-accentSoft hover:bg-accentSoft hover:border-accent transition"
    >
      <code className="text-[12px] text-accent font-mono font-semibold tracking-tight block">
        {label}
      </code>
      <div className="text-[10px] text-ink2 mt-0.5">{note}</div>
    </Link>
  );
}

function MartCard({
  label,
  note,
  href,
}: {
  label: string;
  note: string;
  href: string;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-paper border border-line2 hover:border-accent transition"
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-ink tracking-tight">{label}</div>
        <div className="text-[10px] text-muted">{note}</div>
      </div>
      <span className="text-accent text-xs">→</span>
    </Link>
  );
}

function Arrow(): JSX.Element {
  return (
    <div className="hidden lg:flex flex-col items-center justify-center px-2 self-stretch">
      <svg width="40" height="100" viewBox="0 0 40 100" className="text-line">
        <defs>
          <linearGradient id="arrow-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
            <stop offset="50%" stopColor="currentColor" stopOpacity="0.6" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.15" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          y1="50"
          x2="32"
          y2="50"
          stroke="url(#arrow-grad)"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
        <path d="M32 45 L40 50 L32 55 Z" fill="currentColor" opacity="0.5" />
      </svg>
    </div>
  );
}
