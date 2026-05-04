'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';

interface Health {
  generatedAt: string;
  database: { status: string; latencyMs: number; rowCounts: Array<{ table: string; rows: number }> };
  redis: { status: string; latencyMs: number; queueDepth: { webhook: number; webhookActive: number; webhookFailed: number; aggregation: number } };
  sessions: { active: number; recentLogins24h: number; failedLogins24h: number };
  privacy: { piiAccess24h: number };
}

interface WebhookHealth {
  windowHours: number;
  bySource: Array<{ source: string; total: number; processed: number; failed: number; backlog: number; successRate: number; lastReceivedAt: string | null }>;
}

export default function SystemHealthPage(): JSX.Element {
  const h = useQuery({
    queryKey: ['ops.health'],
    queryFn: () => api<Health>('/admin/health'),
    refetchInterval: 10_000,
  });
  const w = useQuery({
    queryKey: ['ops.webhook-health'],
    queryFn: () => api<WebhookHealth>('/admin/webhook-events/health'),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="System health"
        subtitle="The platform's vitals · refreshes every 10 seconds"
        action={h.data && <span className="text-[11px] text-muted">last poll {formatDateTime(h.data.generatedAt)}</span>}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Database"
          value={h.data ? `${h.data.database.latencyMs} ms` : '…'}
          hint={h.data ? `status ${h.data.database.status}` : 'polling'}
        />
        <KpiCard
          label="Redis"
          value={h.data ? `${h.data.redis.latencyMs} ms` : '…'}
          hint={h.data ? `status ${h.data.redis.status}` : 'polling'}
        />
        <KpiCard
          label="Active sessions"
          value={h.data ? formatNumber(h.data.sessions.active) : '…'}
          hint={h.data ? `${h.data.sessions.recentLogins24h} logins · ${h.data.sessions.failedLogins24h} failed (24h)` : ''}
        />
        <KpiCard
          label="PII access (24h)"
          value={h.data ? formatNumber(h.data.privacy.piiAccess24h) : '…'}
          hint="every reveal logged"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SectionCard title="BullMQ queues" subtitle="webhook + aggregation" className="lg:col-span-1">
          {h.data ? (
            <div className="space-y-3 text-sm">
              <Row k="Webhook · waiting" v={formatNumber(h.data.redis.queueDepth.webhook)} tone={h.data.redis.queueDepth.webhook > 100 ? 'warn' : 'ok'} />
              <Row k="Webhook · active" v={formatNumber(h.data.redis.queueDepth.webhookActive)} tone="ok" />
              <Row k="Webhook · failed" v={formatNumber(h.data.redis.queueDepth.webhookFailed)} tone={h.data.redis.queueDepth.webhookFailed > 0 ? 'danger' : 'ok'} />
              <Row k="Aggregation · waiting" v={formatNumber(h.data.redis.queueDepth.aggregation)} tone="ok" />
            </div>
          ) : <div className="text-muted text-sm">…</div>}
        </SectionCard>

        <SectionCard title="Webhook health (24h)" subtitle="per source · success rate · backlog" className="lg:col-span-2" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Processed</th>
                  <th className="text-right">Failed</th>
                  <th className="text-right">Backlog</th>
                  <th className="text-right">Success rate</th>
                  <th>Last received</th>
                </tr>
              </thead>
              <tbody>
                {(w.data?.bySource ?? []).map((s) => (
                  <tr key={s.source}>
                    <td><StatusPill>{s.source}</StatusPill></td>
                    <td className="numeric text-right text-ink">{formatNumber(s.total)}</td>
                    <td className="numeric text-right text-success">{formatNumber(s.processed)}</td>
                    <td className={`numeric text-right ${s.failed > 0 ? 'text-danger' : 'text-muted'}`}>{formatNumber(s.failed)}</td>
                    <td className={`numeric text-right ${s.backlog > 0 ? 'text-warn' : 'text-muted'}`}>{formatNumber(s.backlog)}</td>
                    <td className="numeric text-right text-ink2">{formatPct(s.successRate)}</td>
                    <td className="numeric text-muted whitespace-nowrap">{s.lastReceivedAt ? formatDateTime(s.lastReceivedAt) : 'never'}</td>
                  </tr>
                ))}
                {!w.data && <tr><td colSpan={7} className="text-muted text-center py-8">…</td></tr>}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Database row counts" subtitle="live from pg_stat_user_tables" bodyClassName="p-0">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-px bg-line">
          {(h.data?.database.rowCounts ?? []).map((r) => (
            <div key={r.table} className="bg-surface p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted">{r.table}</div>
              <div className="numeric text-2xl text-ink font-semibold mt-1">{formatNumber(r.rows)}</div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone: 'ok' | 'warn' | 'danger' }): JSX.Element {
  const cls = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warn' : 'text-danger';
  return (
    <div className="flex items-center justify-between border-b border-line/60 last:border-b-0 py-1.5">
      <span className="text-muted">{k}</span>
      <span className={`numeric font-medium ${cls}`}>{v}</span>
    </div>
  );
}
