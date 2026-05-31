'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface AlertRow {
  id: string;
  rule: { id: string; name: string; severity: string };
  state: 'OPEN' | 'ACKNOWLEDGED' | 'SNOOZED' | 'RESOLVED';
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  payload: unknown;
  firedAt: string;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
}

interface RuleRow {
  id: string;
  name: string;
  description: string | null;
  windowMinutes: number;
  severity: string;
  isActive: boolean;
  channel: { id: string; name: string; kind: string } | null;
  createdAt: string;
}

export default function AlertsPage(): JSX.Element {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'open' | 'all' | 'rules'>('open');

  const alerts = useQuery({
    queryKey: ['alerts', tab],
    queryFn: () => api<AlertRow[]>(`/alerts${tab === 'open' ? '?state=OPEN' : ''}&limit=100`),
    enabled: tab !== 'rules',
  });
  const rules = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api<RuleRow[]>('/alert-rules'),
    enabled: tab === 'rules',
  });

  const ack = useMutation({
    mutationFn: (id: string) => api(`/alerts/${id}/acknowledge`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api(`/alerts/${id}/resolve`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
  const snooze = useMutation({
    mutationFn: (id: string) =>
      api(`/alerts/${id}/snooze`, { method: 'POST', body: JSON.stringify({ minutes: 60 }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const aRows = alerts.data ?? [];
  const rRows = rules.data ?? [];
  const open = aRows.filter((a) => a.state === 'OPEN').length;
  const ackd = aRows.filter((a) => a.state === 'ACKNOWLEDGED').length;
  const snoozed = aRows.filter((a) => a.state === 'SNOOZED').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        subtitle="Operator-facing signals. Acknowledge, snooze, or resolve."
        action={
          <div className="flex gap-1">
            {(['open', 'all', 'rules'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs rounded-md border ${tab === t ? 'border-accent text-accent bg-accentSoft' : 'border-line text-ink2 hover:bg-paper'}`}
              >
                {t === 'open' ? 'Open' : t === 'all' ? 'All' : 'Rules'}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Open" value={open.toString()} hint="not yet handled" />
        <KpiCard label="Acknowledged" value={ackd.toString()} hint="someone owns it" />
        <KpiCard label="Snoozed" value={snoozed.toString()} hint="re-fires later" />
        <KpiCard label="Rules" value={rRows.length.toString()} hint="evaluated by worker" />
      </div>

      {tab === 'rules' ? (
        <SectionCard
          title="Alert rules"
          subtitle="Rules evaluated by the alerts worker. Schedule not yet wired — see ROADMAP."
          bodyClassName="p-0"
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Severity</th>
                <th>Window</th>
                <th>Channel</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {rRows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="text-ink font-medium">{r.name}</div>
                    {r.description && <div className="text-xs text-muted">{r.description}</div>}
                  </td>
                  <td>
                    <StatusPill>{r.severity}</StatusPill>
                  </td>
                  <td className="numeric text-ink2 text-xs">{r.windowMinutes} min</td>
                  <td className="text-xs text-ink2">
                    {r.channel ? `${r.channel.name} (${r.channel.kind})` : '—'}
                  </td>
                  <td>
                    {r.isActive ? (
                      <StatusPill>ACTIVE</StatusPill>
                    ) : (
                      <StatusPill>INACTIVE</StatusPill>
                    )}
                  </td>
                </tr>
              ))}
              {rRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted py-8 text-center">
                    No rules defined yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </SectionCard>
      ) : (
        <SectionCard
          title={tab === 'open' ? `${aRows.length} open` : `${aRows.length} alerts`}
          bodyClassName="p-0"
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Fired</th>
                <th>Rule</th>
                <th>Severity</th>
                <th>State</th>
                <th>Detail</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {aRows.map((a) => (
                <tr key={a.id}>
                  <td className="numeric text-muted text-xs whitespace-nowrap">
                    {formatDateTime(a.firedAt)}
                  </td>
                  <td className="text-ink font-medium">{a.rule.name}</td>
                  <td>
                    <StatusPill>{a.severity}</StatusPill>
                  </td>
                  <td>
                    <StatusPill>{a.state}</StatusPill>
                  </td>
                  <td className="text-[11px] text-muted truncate max-w-[260px]">
                    <code>{JSON.stringify(a.payload)}</code>
                  </td>
                  <td className="text-right space-x-2">
                    {a.state === 'OPEN' && (
                      <>
                        <button
                          onClick={() => ack.mutate(a.id)}
                          className="text-[11px] text-accent hover:underline"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => snooze.mutate(a.id)}
                          className="text-[11px] text-accent hover:underline"
                        >
                          Snooze 60m
                        </button>
                      </>
                    )}
                    {a.state !== 'RESOLVED' && (
                      <button
                        onClick={() => resolve.mutate(a.id)}
                        className="text-[11px] text-accent hover:underline"
                      >
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {aRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted py-8 text-center">
                    No alerts.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </SectionCard>
      )}
    </div>
  );
}
