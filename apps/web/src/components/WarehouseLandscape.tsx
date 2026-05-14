'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { PulseDot } from './PulseDot';

interface LandscapeRow {
  table: string;
  label: string;
  group: 'application' | 'credit' | 'revenue' | 'partners' | 'audit';
  rows: number;
  lastAt: string | null;
}

const GROUP_META: Record<LandscapeRow['group'], { label: string; tint: string; tintRgb: string }> =
  {
    application: {
      label: 'Application plane',
      tint: 'border-l-[#3B82F6]',
      tintRgb: 'rgb(59,130,246)',
    },
    credit: {
      label: 'Credit & enrichment',
      tint: 'border-l-[#A855F7]',
      tintRgb: 'rgb(168,85,247)',
    },
    revenue: { label: 'Revenue ledger', tint: 'border-l-[#10B981]', tintRgb: 'rgb(16,185,129)' },
    partners: { label: 'Directory', tint: 'border-l-[#F59E0B]', tintRgb: 'rgb(245,158,11)' },
    audit: { label: 'Audit & event log', tint: 'border-l-[#64748B]', tintRgb: 'rgb(100,116,139)' },
  };

const HREF_FOR_TABLE: Partial<Record<string, string>> = {
  applications: '/applications',
  lender_decisions: '/lenders',
  credit_enrichments: '/highsale',
  pixie_metrics: '/pixie',
  revenue_events: '/revenue/ledger',
  partners: '/partners',
  webhook_events: '/ops/webhooks',
  audit_logs: '/audit',
};

function classify(lastAt: string | null): 'HEALTHY' | 'STALE' | 'IDLE' {
  if (!lastAt) return 'IDLE';
  const age = Date.now() - new Date(lastAt).getTime();
  if (age < 3600_000) return 'HEALTHY';
  if (age < 86_400_000) return 'STALE';
  return 'IDLE';
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Warehouse landscape — every analytical table at a glance, sized by
 * row count and grouped by domain. The visual identity that screams
 * "this is a data warehouse, not an ops console."
 *
 * Each cell shows the table name, row count (big number — this IS the
 * warehouse), a freshness pulse, and a click-through to the page that
 * surfaces that table's data.
 */
export function WarehouseLandscape(): JSX.Element {
  const q = useQuery({
    queryKey: ['warehouse.landscape'],
    queryFn: () => api<{ data: LandscapeRow[] }>('/warehouse/landscape'),
    refetchInterval: 60_000,
  });

  const rows = q.data?.data ?? [];
  const byGroup = new Map<LandscapeRow['group'], LandscapeRow[]>();
  for (const r of rows) {
    const arr = byGroup.get(r.group) ?? [];
    arr.push(r);
    byGroup.set(r.group, arr);
  }

  const groupOrder: LandscapeRow['group'][] = [
    'application',
    'credit',
    'revenue',
    'partners',
    'audit',
  ];

  return (
    <div className="rounded-xl border border-line2 bg-surface overflow-hidden">
      <div className="px-5 py-4 border-b border-line2 flex items-baseline justify-between">
        <div>
          <h2 className="text-ink font-semibold tracking-tight">Warehouse landscape</h2>
          <p className="text-[11px] text-muted mt-0.5">
            8 analytical tables · pulse = fresh in last hour · click to drill into the data
          </p>
        </div>
        <span className="text-[11px] text-muted numeric">
          {formatNumber(rows.reduce((s, r) => s + r.rows, 0))} total rows
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-px bg-line2">
        {groupOrder.map((g) => {
          const tables = byGroup.get(g) ?? [];
          if (tables.length === 0) return null;
          const meta = GROUP_META[g];
          return tables.map((t) => {
            const status = classify(t.lastAt);
            const href = HREF_FOR_TABLE[t.table];
            const body = (
              <div
                className={`bg-surface px-4 py-4 h-full transition group ${href ? 'hover:bg-paper cursor-pointer' : ''}`}
                style={{ borderLeft: `3px solid ${meta.tintRgb}` }}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                    {meta.label}
                  </div>
                  <PulseDot status={status} />
                </div>
                <div className="font-mono text-ink text-[20px] font-semibold tracking-tight tabular-nums">
                  {formatNumber(t.rows)}
                </div>
                <div className="text-[12px] text-ink2 mt-1">{t.label}</div>
                <div className="text-[10px] text-muted mt-2 numeric">
                  <code className="text-[10px]">{t.table}</code> · last {relativeTime(t.lastAt)}
                </div>
              </div>
            );
            return href ? (
              <Link key={t.table} href={href} className="block">
                {body}
              </Link>
            ) : (
              <div key={t.table}>{body}</div>
            );
          });
        })}
      </div>
    </div>
  );
}
