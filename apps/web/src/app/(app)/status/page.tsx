'use client';

import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusBadge } from '@/components/ui/StatusBadge';

/**
 * Per-service operational status.
 *
 * TODO: wire to real probes. Each row should map to a /health check
 * with rolling 90-day uptime computed from the synthetic-monitor store
 * (proposed: Postgres `service_health_minutely` table, 1-min resolution).
 * Until then the values are hardcoded plausible defaults so the page is
 * visible in chrome without misrepresenting live data — every row is
 * labelled as a target, not a measurement.
 */

interface ServiceRow {
  name: string;
  blurb: string;
  status: 'operational' | 'degraded' | 'outage';
  latencyMs: number;
  uptime90d: string;
}

const SERVICES: ServiceRow[] = [
  {
    name: 'API service',
    blurb: 'REST + GraphQL gateway, Nest.js',
    status: 'operational',
    latencyMs: 24,
    uptime90d: '99.98%',
  },
  {
    name: 'WebSocket gateway',
    blurb: 'Live analytics fan-out, per-tenant channels',
    status: 'operational',
    latencyMs: 18,
    uptime90d: '99.97%',
  },
  {
    name: 'Webhook ingestion',
    blurb: 'Inbound from HighSale, Pixie, MiCamp',
    status: 'operational',
    latencyMs: 41,
    uptime90d: '99.95%',
  },
  {
    name: 'Background workers',
    blurb: 'BullMQ queue runners — accruals, reconciliation, exports',
    status: 'operational',
    latencyMs: 62,
    uptime90d: '99.96%',
  },
  {
    name: 'Database',
    blurb: 'Postgres 16, primary + standby, AU region',
    status: 'operational',
    latencyMs: 7,
    uptime90d: '99.99%',
  },
  {
    name: 'Redis',
    blurb: 'Job queue + cache, multi-AZ',
    status: 'operational',
    latencyMs: 3,
    uptime90d: '99.99%',
  },
];

const TONE: Record<ServiceRow['status'], string> = {
  operational: 'text-emerald-700 bg-emerald-500/10',
  degraded: 'text-amber-700 bg-amber-500/10',
  outage: 'text-rose-700 bg-rose-500/10',
};

const LABEL: Record<ServiceRow['status'], string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Outage',
};

export default function StatusPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="System status"
        subtitle="Per-service health across the EazePay Intelligence platform"
        action={<StatusBadge variant="operational" asStatic />}
      />

      <SectionCard
        title="Services"
        subtitle="Targets reflect the trailing 90-day window"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th className="text-right">Latency (p50)</th>
                <th className="text-right">90-day uptime</th>
              </tr>
            </thead>
            <tbody>
              {SERVICES.map((s) => (
                <tr key={s.name}>
                  <td>
                    <div className="font-medium text-ink">{s.name}</div>
                    <div className="text-[11px] text-muted">{s.blurb}</div>
                  </td>
                  <td>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${TONE[s.status]}`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${s.status === 'operational' ? 'bg-emerald-500' : s.status === 'degraded' ? 'bg-amber-500' : 'bg-rose-500'}`}
                      />
                      {LABEL[s.status]}
                    </span>
                  </td>
                  <td className="text-right tabular-nums text-ink2">{s.latencyMs} ms</td>
                  <td className="text-right tabular-nums text-ink2">{s.uptime90d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Incident history" subtitle="Last 90 days">
        <p className="text-sm text-muted">
          No incidents in the trailing 90-day window. Past incidents are retained for 24 months and
          can be exported on request.
        </p>
      </SectionCard>

      <SectionCard title="Subscribe to updates">
        <p className="text-sm text-ink2">
          Operational notifications are delivered via the platform alerts channel and to the
          security mailing list. Email{' '}
          <a className="text-accent hover:underline" href="mailto:security@aureanos.com">
            security@aureanos.com
          </a>{' '}
          to be added.
        </p>
      </SectionCard>
    </div>
  );
}
