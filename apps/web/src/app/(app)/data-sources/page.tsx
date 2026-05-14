'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { PulseDot } from '@/components/PulseDot';
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

interface SourceCard {
  href: string;
  name: string;
  blurb: string;
  icon: LucideIcon;
  statsKey?: 'highsale' | 'pixie' | 'micamp' | 'lenders' | 'partners' | 'webhooks';
}

const SOURCES: SourceCard[] = [
  {
    href: '/data-sources/eazepay-app',
    name: 'EazePay App',
    blurb: 'Application-lifecycle webhooks · offers presented, contracted, declined',
    icon: Database,
  },
  {
    href: '/highsale',
    name: 'HighSale (EZ Check)',
    blurb: 'Per-application credit-data snapshots · ~70 fields · PII encrypted at rest',
    icon: Gauge,
    statsKey: 'highsale',
  },
  {
    href: '/pixie',
    name: 'Pixie',
    blurb: 'Pre-qual usage metering · sub-second hot path · partner-level visibility',
    icon: Sparkles,
    statsKey: 'pixie',
  },
  {
    href: '/micamp',
    name: 'MiCamp',
    blurb: 'Card-processing fees + reversals · 50/50 rev-share materialised per partner',
    icon: CreditCard,
    statsKey: 'micamp',
  },
  {
    href: '/lenders',
    name: 'Lenders',
    blurb: 'Funded-loan reporting from third-party lenders · adapter per lender · 15-min poll',
    icon: Landmark,
    statsKey: 'lenders',
  },
  {
    href: '/partners',
    name: 'Partners',
    blurb: 'Merchant directory feeding every BNPL vertical · onboarding · commercial terms',
    icon: Building2,
    statsKey: 'partners',
  },
  {
    href: '/ops/webhooks',
    name: 'Webhook events log',
    blurb: 'Raw inbound stream across every signed-webhook source · operator view',
    icon: Webhook,
  },
];

interface IngestionStats {
  source: string;
  last24h: number;
  lastReceivedAt: string | null;
  status: 'HEALTHY' | 'STALE' | 'IDLE';
}

const HIGHSALE_SAMPLE = `# HighSale signs every snapshot with HMAC-SHA-256:
ts=$(date +%s)
body='{"vertical":"medpay","external_application_id":"APP-001","snapshot":{...}}'
sig=$(echo -n "\${ts}.\${body}" | openssl dgst -sha256 -hmac "$HIGHSALE_WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://localhost:3010/api/v1/integration/highsale/snapshots \\
  -H "x-highsale-signature: sha256=\${sig}" \\
  -H "x-highsale-timestamp: \${ts}" \\
  -H "idempotency-key: $(uuidgen)" \\
  -H "content-type: application/json" \\
  -d "\${body}"`;

export default function DataSourcesPage(): JSX.Element {
  const stats = useQuery({
    queryKey: ['data-sources.stats'],
    queryFn: () => api<{ data: IngestionStats[] }>('/data-sources/stats'),
    retry: false,
    refetchInterval: 30_000,
  });

  const byKey = new Map<string, IngestionStats>(
    (stats.data?.data ?? []).map((s) => [s.source.toLowerCase(), s]),
  );

  const totalEvents = (stats.data?.data ?? []).reduce((s, r) => s + r.last24h, 0);
  const healthyCount = (stats.data?.data ?? []).filter((s) => s.status === 'HEALTHY').length;

  return (
    <div className="space-y-7">
      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border border-line2 bg-gradient-to-br from-[#0B1220] via-[#111d34] to-[#0F172A] text-surface px-7 lg:px-10 py-8 lg:py-9">
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div
          className="absolute -left-32 -bottom-32 w-[420px] h-[420px] rounded-full opacity-25 pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(168,85,247,0.55) 0%, rgba(168,85,247,0) 70%)',
          }}
        />

        <div className="relative">
          <PageHeader
            title=""
            subtitle=""
            hideBack
            crumbs={[{ label: 'Overview', href: '/overview' }, { label: 'Data sources' }]}
          />
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-blue-300/70 mb-3">
            <PulseDot status={healthyCount > 0 ? 'HEALTHY' : 'IDLE'} />
            <span>Data sources · live ingestion</span>
          </div>
          <h1 className="text-[34px] lg:text-[42px] font-semibold tracking-tighter mb-2 bg-gradient-to-r from-white via-white to-blue-200 bg-clip-text text-transparent">
            Where your data comes from
          </h1>
          <p className="text-[14px] text-blue-100/70 max-w-2xl mb-6">
            Four inbound planes feed the warehouse. Each one has its own ingestion path, HMAC
            secret, and freshness SLO. Click a source to drill into the data it's produced.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-10 gap-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-blue-200/50 mb-1">
                Events · last 24h
              </div>
              <div className="text-[26px] font-semibold tracking-tight tabular-nums">
                {formatNumber(totalEvents)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-blue-200/50 mb-1">
                Healthy feeds
              </div>
              <div className="text-[26px] font-semibold tracking-tight tabular-nums text-emerald-300">
                {healthyCount}
                <span className="text-[14px] text-blue-200/40 ml-1.5 font-normal">
                  / {SOURCES.length}
                </span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-blue-200/50 mb-1">
                Refresh cadence
              </div>
              <div className="text-[26px] font-semibold tracking-tight tabular-nums">30s</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── SOURCE CARDS ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SOURCES.map((s) => {
          const Icon = s.icon;
          const stat = s.statsKey ? byKey.get(s.statsKey) : undefined;
          const status = stat?.status ?? 'IDLE';
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
                    {stat && (
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-ink2">
                        <PulseDot status={status} />
                        {status}
                      </span>
                    )}
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

      {/* ── HMAC SAMPLE ──────────────────────────────────────────────── */}
      <SectionCard
        title="Seeding your first event"
        subtitle="HMAC-SHA-256 over `${timestamp}.${rawBody}` · sample for HighSale"
        bodyClassName="p-0"
      >
        <pre className="text-[12px] leading-relaxed bg-[#0F172A] text-[#E2E8F0] px-5 py-4 overflow-x-auto rounded-b-xl font-mono">
          {HIGHSALE_SAMPLE}
        </pre>
      </SectionCard>

      {/* ── HOW DATA FLOWS ───────────────────────────────────────────── */}
      <SectionCard title="How data flows" bodyClassName="p-5">
        <div className="text-sm text-ink2 space-y-3 leading-relaxed">
          <ol className="list-decimal list-inside space-y-1 text-ink2">
            <li>
              <strong className="text-ink">EazePay App</strong> ·{' '}
              <code className="kbd">/integration/eazepay-app/events</code> — application lifecycle
            </li>
            <li>
              <strong className="text-ink">HighSale</strong> ·{' '}
              <code className="kbd">/integration/highsale/snapshots</code> — credit-data enrichments
              per applicant
            </li>
            <li>
              <strong className="text-ink">Lenders</strong> · per-lender adapter polls reporting API
              every 15 minutes
            </li>
            <li>
              <strong className="text-ink">MiCamp + Pixie</strong> ·{' '}
              <code className="kbd">/webhooks/&#123;source&#125;/&#123;event&#125;</code> —
              processing + usage events
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
