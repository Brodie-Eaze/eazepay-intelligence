'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import {
  Database,
  Gauge,
  Sparkles,
  CreditCard,
  Landmark,
  Building2,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

/**
 * The "where does my data come from?" hub. Every inbound plane shows
 * up here with its health (freshness, recent volume) and a deep-link
 * to its dedicated page.
 *
 * Each card answers three questions in two seconds:
 *   1. Is the feed alive? (status pill)
 *   2. When did the last row land? (relative time)
 *   3. How many rows today? (count)
 */

interface SourceCard {
  href: string;
  name: string;
  blurb: string;
  icon: LucideIcon;
  /** API key to query for stats. Currently best-effort — when a stats
   *  endpoint doesn't exist for a source, the card renders without
   *  numbers and that's fine. */
  statsKey?: 'highsale' | 'pixie' | 'micamp' | 'lenders' | 'partners' | 'webhooks';
}

const SOURCES: SourceCard[] = [
  {
    href: '/data-sources/eazepay-app',
    name: 'EazePay App',
    blurb:
      'Application-lifecycle webhooks from the operational platform — offers presented, contracted, declined.',
    icon: Database,
  },
  {
    href: '/highsale',
    name: 'HighSale (EZ Check)',
    blurb:
      'Per-application credit-data snapshots — ~70 fields per applicant. PII encrypted at rest.',
    icon: Gauge,
    statsKey: 'highsale',
  },
  {
    href: '/pixie',
    name: 'Pixie',
    blurb: 'Pre-qual usage metering. Sub-second hot path; partner-level visibility.',
    icon: Sparkles,
    statsKey: 'pixie',
  },
  {
    href: '/micamp',
    name: 'MiCamp',
    blurb: 'Card-processing fees + reversals. 50/50 rev-share materialised per partner.',
    icon: CreditCard,
    statsKey: 'micamp',
  },
  {
    href: '/lenders',
    name: 'Lenders',
    blurb:
      'Funded-loan reporting from third-party lenders. Adapter per lender; pulled every 15 minutes.',
    icon: Landmark,
    statsKey: 'lenders',
  },
  {
    href: '/partners',
    name: 'Partners',
    blurb: 'Merchant directory feeding every BNPL vertical — onboarding, status, commercial terms.',
    icon: Building2,
    statsKey: 'partners',
  },
  {
    href: '/ops/webhooks',
    name: 'Webhook events log',
    blurb: 'Raw inbound stream across every signed-webhook source. Operator view.',
    icon: Webhook,
  },
];

interface IngestionStats {
  source: string;
  last24h: number;
  lastReceivedAt: string | null;
  status: 'HEALTHY' | 'STALE' | 'IDLE';
}

export default function DataSourcesPage(): JSX.Element {
  const stats = useQuery({
    queryKey: ['data-sources.stats'],
    queryFn: () => api<{ data: IngestionStats[] }>('/data-sources/stats'),
    // The stats endpoint is best-effort; if it doesn't exist yet (404)
    // the page still renders, the cards just don't show numbers.
    retry: false,
  });

  const byKey = new Map<string, IngestionStats>(
    (stats.data?.data ?? []).map((s) => [s.source.toLowerCase(), s]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data sources"
        subtitle="Every upstream feed into the warehouse · click a source to drill into its data"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SOURCES.map((s) => {
          const Icon = s.icon;
          const stat = s.statsKey ? byKey.get(s.statsKey) : undefined;
          return (
            <Link
              key={s.href}
              href={s.href}
              className="card card-pad block hover:border-accent transition group"
            >
              <div className="flex items-start gap-4">
                <div className="rounded-lg bg-paper p-2.5 border border-line2 group-hover:border-accent transition">
                  <Icon size={18} className="text-ink2 group-hover:text-accent transition" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <h3 className="text-ink font-semibold tracking-tight">{s.name}</h3>
                    {stat && <StatusPill>{stat.status}</StatusPill>}
                  </div>
                  <p className="text-sm text-ink2 leading-relaxed mb-3">{s.blurb}</p>
                  <div className="flex items-center gap-4 text-[11px] text-muted">
                    {stat ? (
                      <>
                        <span className="numeric">
                          <strong className="text-ink2">{formatNumber(stat.last24h)}</strong> events
                          / 24h
                        </span>
                        {stat.lastReceivedAt && (
                          <span>last {formatDateTime(stat.lastReceivedAt)}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-soft">
                        stats endpoint pending · click to drill into the source page
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      <SectionCard title="How data flows" bodyClassName="p-5">
        <div className="text-sm text-ink2 space-y-3 leading-relaxed">
          <p>
            <strong className="text-ink">Four inbound planes</strong> feed the warehouse, each with
            its own ingestion path and HMAC secret. Persisted rows fan out to the marts layer (dbt)
            for cross-source analytics.
          </p>
          <ol className="list-decimal list-inside space-y-1 text-ink2">
            <li>
              <strong className="text-ink">EazePay App</strong> · signed POST to{' '}
              <code className="kbd">/integration/eazepay-app/events</code> — application lifecycle.
            </li>
            <li>
              <strong className="text-ink">HighSale</strong> · signed POST to{' '}
              <code className="kbd">/integration/highsale/snapshots</code> — credit-data enrichments
              per applicant.
            </li>
            <li>
              <strong className="text-ink">Lenders</strong> · background workers pull each lender's
              reporting API every 15 min.
            </li>
            <li>
              <strong className="text-ink">MiCamp + Pixie</strong> · signed POST to{' '}
              <code className="kbd">/webhooks/&#123;source&#125;/&#123;event&#125;</code> —
              processing + usage events.
            </li>
          </ol>
          <p className="text-muted text-xs pt-1">
            Full contract: <code className="kbd">docs/architecture/data-warehouse-overview.md</code>
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
