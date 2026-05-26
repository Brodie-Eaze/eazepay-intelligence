'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Briefcase, ArrowUpRight } from 'lucide-react';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface VerticalRow {
  slug: string;
  name: string;
  description: string;
  businessCount: number;
  activeCount: number;
  ttmRevenue: number;
  ttmEbitda: number;
  ebitdaMargin: number;
  fteCount: number;
}

interface PortfolioIndex {
  verticals: VerticalRow[];
  rollup: {
    businessCount: number;
    activeCount: number;
    ttmRevenue: number;
    ttmEbitda: number;
    fteCount: number;
    cashOnHand: number;
    netDebt: number;
  };
}

export default function PortfolioIndex(): JSX.Element {
  const q = useQuery({
    queryKey: ['portfolio.index'],
    queryFn: () => api<PortfolioIndex>('/portfolio'),
  });

  const data = q.data;
  const r = data?.rollup;

  // 30-day trend series. The /portfolio rollup endpoint returns point-in-
  // time TTM only — no historical samples — so we synthesise a smooth
  // anchored walk per metric to demonstrate the sparkline. Wire to real
  // history once the API exposes it (tracked separately).
  const revenueSpark = mockSpark('revenue');
  const ebitdaSpark = mockSpark('ebitda');
  const cashSpark = mockSpark('cash');
  const fteSpark = mockSpark('fte');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        subtitle="Every business under the group, grouped by vertical · rolled up to a single holdco view"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="TTM revenue"
          value={r ? formatMoney(r.ttmRevenue) : '…'}
          hint={r ? `${formatNumber(r.activeCount)} active businesses` : ''}
          sparkline={revenueSpark}
        />
        <KpiCard
          label="TTM EBITDA"
          value={r ? formatMoney(r.ttmEbitda) : '…'}
          hint={r ? `${formatPct(r.ttmRevenue ? r.ttmEbitda / r.ttmRevenue : 0)} margin` : ''}
          sparkline={ebitdaSpark}
        />
        <KpiCard
          label="Cash on hand"
          value={r ? formatMoney(r.cashOnHand) : '…'}
          hint={
            r && r.netDebt < 0
              ? `${formatMoney(Math.abs(r.netDebt))} net cash`
              : r
                ? `${formatMoney(r.netDebt)} net debt`
                : ''
          }
          sparkline={cashSpark}
        />
        <KpiCard
          label="Headcount"
          value={r ? formatNumber(r.fteCount) : '…'}
          hint="across portfolio"
          sparkline={fteSpark}
        />
      </div>

      <SectionCard
        title="Verticals"
        subtitle="click into a vertical to see its businesses · roll-ups are TTM"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-1 md:grid-cols-3">
          {(data?.verticals ?? []).map((v) => (
            <Link
              key={v.slug}
              href={`/portfolio/${v.slug}`}
              className="group p-5 border-b md:border-b-0 md:border-r border-line2 last:border-r-0 hover:bg-surface2 transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="h-8 w-8 rounded-md bg-surface2 flex items-center justify-center text-accent">
                    <Briefcase size={15} />
                  </span>
                  <div>
                    <div className="font-medium tracking-tight text-ink">{v.name}</div>
                    <div className="text-[11px] text-muted">
                      {v.businessCount} {v.businessCount === 1 ? 'business' : 'businesses'} ·{' '}
                      {v.activeCount} active
                    </div>
                  </div>
                </div>
                <ArrowUpRight size={14} className="text-muted group-hover:text-accent transition" />
              </div>
              <p className="text-xs text-muted mt-3 leading-snug">{v.description}</p>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <Stat label="TTM rev" value={formatMoney(v.ttmRevenue)} />
                <Stat label="EBITDA" value={formatMoney(v.ttmEbitda)} />
                <Stat label="Margin" value={formatPct(v.ebitdaMargin)} />
              </div>
            </Link>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Holdco roll-up"
        subtitle="aggregated trailing-twelve-months · refreshes nightly from each business's reporting feed"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 divide-x divide-line2">
          <Cell
            label="Businesses"
            value={r ? formatNumber(r.businessCount) : '—'}
            hint="all statuses"
          />
          <Cell
            label="Active"
            value={r ? formatNumber(r.activeCount) : '—'}
            hint="excl. integrating / prospect"
          />
          <Cell
            label="TTM revenue"
            value={r ? formatMoney(r.ttmRevenue) : '—'}
            hint="sum across businesses"
          />
          <Cell
            label="TTM EBITDA"
            value={r ? formatMoney(r.ttmEbitda) : '—'}
            hint={r ? formatPct(r.ttmRevenue ? r.ttmEbitda / r.ttmRevenue : 0) + ' margin' : ''}
          />
          <Cell label="Cash" value={r ? formatMoney(r.cashOnHand) : '—'} hint="end of period" />
          <Cell
            label="Net debt"
            value={r ? formatMoney(r.netDebt) : '—'}
            hint={r && r.netDebt < 0 ? 'net cash position' : 'gross debt − cash'}
          />
        </div>
      </SectionCard>
    </div>
  );
}

// Deterministic 30-point series keyed by a seed string. Stable across
// renders (no SSR/CSR mismatch, no jitter on refetch) and varied enough
// per-metric to look like a real trend, not a sine wave. Replace with
// API-supplied history once exposed.
function mockSpark(seed: string): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const out: number[] = [];
  let v = 50 + (h % 30);
  for (let i = 0; i < 30; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const drift = ((h % 1000) / 1000 - 0.45) * 8;
    v = Math.max(5, v + drift);
    out.push(v);
  }
  return out;
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">{label}</div>
      <div className="numeric text-sm font-semibold tracking-tight text-ink mt-0.5">{value}</div>
    </div>
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
      <div className="numeric text-[20px] font-semibold tracking-tight text-ink mt-1">{value}</div>
      {hint && <div className="text-[11px] text-muted mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}
