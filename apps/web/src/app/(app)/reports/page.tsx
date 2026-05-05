'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface ReportRow {
  id: string;
  name: string;
  reportType: string;
  cronExpression: string;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  channel: { id: string; name: string; kind: string } | null;
  lastRun: { id: string; status: string; createdAt: string } | null;
}

const REPORT_TYPES = [
  'CUSTOMERS',
  'APPLICATIONS',
  'LENDER_DECISIONS',
  'REVENUE_LEDGER',
  'PARTNERS',
  'AUDIT_LOG',
];

export default function ScheduledReportsPage(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['scheduled-reports'],
    queryFn: () => api<ReportRow[]>('/scheduled-reports'),
  });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [reportType, setReportType] = useState('CUSTOMERS');
  const [cron, setCron] = useState('0 9 * * MON');

  const create = useMutation({
    mutationFn: () =>
      api('/scheduled-reports', {
        method: 'POST',
        body: JSON.stringify({ name, reportType, cronExpression: cron }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-reports'] });
      setShowForm(false);
      setName('');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/scheduled-reports/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-reports'] }),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api(`/scheduled-reports/${id}/run`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-reports'] }),
  });

  const rows = q.data ?? [];
  const active = rows.filter((r) => r.isActive).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scheduled reports"
        subtitle="Recurring exports → Slack / email / webhook · cron-driven"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-xs px-3 py-1.5 rounded-md bg-ink text-surface font-medium hover:bg-ink2"
          >
            {showForm ? 'Cancel' : '+ New schedule'}
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Schedules" value={rows.length.toString()} hint={`${active} active`} />
        <KpiCard
          label="Report types"
          value={REPORT_TYPES.length.toString()}
          hint="any export type"
        />
        <KpiCard label="Channels" value="—" hint="configure under Workspace › Channels" />
      </div>

      {showForm && (
        <SectionCard title="New schedule" subtitle="cron format · five fields · UTC">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label className="block">
              <span className="h-section block mb-1.5">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Weekly customer book"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="h-section block mb-1.5">Report type</span>
              <select
                value={reportType}
                onChange={(e) => setReportType(e.target.value)}
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              >
                {REPORT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="h-section block mb-1.5">Cron</span>
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * MON"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-accent"
              />
            </label>
          </div>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name}
            className="mt-4 px-4 py-2 rounded-md bg-accent text-surface text-sm font-medium disabled:opacity-50 hover:bg-accent/90"
          >
            {create.isPending ? 'Saving…' : 'Save schedule'}
          </button>
        </SectionCard>
      )}

      <SectionCard
        title={`${rows.length} schedule${rows.length === 1 ? '' : 's'}`}
        bodyClassName="p-0"
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Report</th>
              <th>Cron</th>
              <th>Last run</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="font-medium text-ink">{r.name}</td>
                <td>
                  <span className="tag">{r.reportType.replace(/_/g, ' ')}</span>
                </td>
                <td>
                  <code className="tag">{r.cronExpression}</code>
                </td>
                <td className="text-xs text-muted">
                  {r.lastRun
                    ? `${r.lastRun.status} · ${formatDateTime(r.lastRun.createdAt)}`
                    : 'never'}
                </td>
                <td>
                  <StatusPill>{r.isActive ? 'ACTIVE' : 'INACTIVE'}</StatusPill>
                </td>
                <td className="text-right space-x-2">
                  <button
                    onClick={() => runNow.mutate(r.id)}
                    className="text-[11px] text-accent hover:underline"
                  >
                    Run now
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${r.name}"?`)) remove.mutate(r.id);
                    }}
                    className="text-[11px] text-danger hover:underline"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted py-8 text-center">
                  No schedules yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}
