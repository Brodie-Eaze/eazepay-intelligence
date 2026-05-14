'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface WebhookRow {
  id: string;
  source: string;
  eventType: string;
  idempotencyKey: string;
  signatureValid: boolean;
  status: string;
  processingError: string | null;
  receivedAt: string;
  processedAt: string | null;
  latencyMs: number | null;
}

const SOURCES = ['', 'PIXIE', 'MICAMP'] as const;
const STATUSES = ['', 'RECEIVED', 'PROCESSED', 'FAILED', 'REPLAYED'] as const;

export default function WebhookEventsPage(): JSX.Element {
  const [source, setSource] = useState<(typeof SOURCES)[number]>('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('');

  const q = useQuery({
    queryKey: ['ops.webhooks', source, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (source) params.set('source', source);
      if (status) params.set('status', status);
      params.set('limit', '100');
      return api<WebhookRow[]>(`/admin/webhook-events?${params.toString()}`);
    },
    refetchInterval: 10_000,
  });

  const rows = q.data ?? [];
  const counts = rows.reduce(
    (a, r) => {
      a[r.status] = (a[r.status] ?? 0) + 1;
      return a;
    },
    {} as Record<string, number>,
  );
  const avgLatency = (() => {
    const samples = rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs as number);
    return samples.length ? Math.round(samples.reduce((s, n) => s + n, 0) / samples.length) : 0;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhook events"
        subtitle="Every inbound webhook · signature-valid · idempotency-safe · replayable"
        action={
          <div className="flex items-center gap-2">
            <Select
              label="Source"
              value={source}
              onChange={setSource as (v: string) => void}
              options={SOURCES}
            />
            <Select
              label="Status"
              value={status}
              onChange={setStatus as (v: string) => void}
              options={STATUSES}
            />
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="In view" value={formatNumber(rows.length)} hint="last 100 with filters" />
        <KpiCard
          label="Processed"
          value={formatNumber(counts.PROCESSED ?? 0)}
          hint={`${counts.RECEIVED ?? 0} received pending`}
        />
        <KpiCard
          label="Failed"
          value={formatNumber(counts.FAILED ?? 0)}
          hint={counts.FAILED ? 'inspect & replay' : 'all green'}
        />
        <KpiCard label="Avg latency" value={`${avgLatency} ms`} hint="received → processed" />
      </div>

      <SectionCard title="Event log" subtitle="ordered by received_at desc" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Received</th>
                <th>Source</th>
                <th>Event type</th>
                <th>Status</th>
                <th>Sig</th>
                <th className="text-right">Latency</th>
                <th>Idempotency key</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="numeric text-muted whitespace-nowrap">
                    {formatDateTime(r.receivedAt)}
                  </td>
                  <td>
                    <StatusPill>{r.source}</StatusPill>
                  </td>
                  <td className="text-ink2 numeric">{r.eventType}</td>
                  <td>
                    <StatusPill>{r.status}</StatusPill>
                  </td>
                  <td>
                    {r.signatureValid ? (
                      <span className="pill pill-success">OK</span>
                    ) : (
                      <span className="pill pill-danger">BAD</span>
                    )}
                  </td>
                  <td className="numeric text-right text-ink2">
                    {r.latencyMs != null ? `${r.latencyMs} ms` : '—'}
                  </td>
                  <td className="text-[11px] text-muted truncate max-w-[280px]">
                    <code>{r.idempotencyKey}</code>
                  </td>
                  <td className="text-[11px] text-danger truncate max-w-[260px]">
                    {r.processingError ?? ''}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted py-8 text-center">
                    No webhook events.
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

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface border border-line rounded-md px-2 py-1.5 text-ink2 outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || 'all'}
          </option>
        ))}
      </select>
    </label>
  );
}
