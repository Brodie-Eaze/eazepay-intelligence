'use client';

/**
 * /platform/reconciliation — cross-org integrity snapshot (GAP-112 UI).
 *
 * Renders one row per org: revenue 7d, applications, webhooks processed,
 * quarantined, DLQ, active DEKs. health = OK | ATTENTION based on the
 * server-side computed flags.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';

function formatAUD(v: string): string {
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

interface ReconciliationRow {
  orgId: string;
  orgSlug: string;
  orgName: string;
  window: string;
  revenueAmount: string;
  revenueEvents: number;
  applicationsCreated: number;
  webhookEventsProcessed: number;
  quarantinedTotal: number;
  outboxDlqTotal: number;
  activeDeks: number;
  health: 'OK' | 'ATTENTION';
}

interface ReconciliationResponse {
  window: string;
  rows: ReconciliationRow[];
}

export default function ReconciliationPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['platform', 'reconciliation'],
    queryFn: () => api<ReconciliationResponse>('/platform/reconciliation'),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Platform · reconciliation"
        subtitle="Per-org 7-day integrity snapshot. Drift between ingest counters and normalised tables is the first signal an integration is broken."
      />

      <SectionCard title={`${q.data?.rows.length ?? 0} orgs · last ${q.data?.window ?? '—'}`}>
        {q.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : q.isError ? (
          <p className="text-sm text-red-600">Failed to load reconciliation snapshot.</p>
        ) : (q.data?.rows ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">No orgs.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b">
                <th className="py-2 text-left">Org</th>
                <th className="text-right">Revenue 7d</th>
                <th className="text-right">Apps</th>
                <th className="text-right">Webhooks OK</th>
                <th className="text-right">Quarantined</th>
                <th className="text-right">DLQ</th>
                <th className="text-right">DEKs</th>
                <th className="text-right">Health</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.rows.map((r) => (
                <tr key={r.orgId} className="border-b last:border-0">
                  <td className="py-2">
                    <div className="font-medium">{r.orgName}</div>
                    <div className="font-mono text-xs text-zinc-500">{r.orgSlug}</div>
                  </td>
                  <td className="text-right">{formatAUD(r.revenueAmount)}</td>
                  <td className="text-right">{formatNumber(r.applicationsCreated)}</td>
                  <td className="text-right">{formatNumber(r.webhookEventsProcessed)}</td>
                  <td className="text-right">
                    {r.quarantinedTotal > 0 ? (
                      <span className="font-medium text-amber-700">
                        {formatNumber(r.quarantinedTotal)}
                      </span>
                    ) : (
                      formatNumber(r.quarantinedTotal)
                    )}
                  </td>
                  <td className="text-right">
                    {r.outboxDlqTotal > 0 ? (
                      <span className="font-medium text-red-700">
                        {formatNumber(r.outboxDlqTotal)}
                      </span>
                    ) : (
                      formatNumber(r.outboxDlqTotal)
                    )}
                  </td>
                  <td className="text-right">{r.activeDeks}</td>
                  <td className="text-right">
                    <StatusPill>{r.health}</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
