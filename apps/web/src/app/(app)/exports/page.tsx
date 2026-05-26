'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';
import { MobileCardList, MobileCardRow } from '@/components/MobileCardRow';

interface ExportRow {
  id: string;
  type: string;
  format: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  rowCount: number | null;
  fileBytes: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

const TYPES = [
  'CUSTOMERS',
  'APPLICATIONS',
  'LENDER_DECISIONS',
  'REVENUE_LEDGER',
  'PARTNERS',
  'AUDIT_LOG',
] as const;
const FORMATS = ['CSV', 'JSON', 'XLSX'] as const;

export default function ExportsPage(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['exports'],
    queryFn: () => api<ExportRow[]>('/exports'),
    refetchInterval: 5_000,
  });

  const [type, setType] = useState<(typeof TYPES)[number]>('CUSTOMERS');
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('CSV');

  const create = useMutation({
    mutationFn: () =>
      api<ExportRow>('/exports', { method: 'POST', body: JSON.stringify({ type, format }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exports'] }),
  });

  const rows = q.data ?? [];
  const running = rows.filter((r) => r.status === 'RUNNING' || r.status === 'PENDING').length;
  const completed = rows.filter((r) => r.status === 'COMPLETED').length;
  const failed = rows.filter((r) => r.status === 'FAILED').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data exports"
        subtitle="Async dump of any resource — CSV / JSON · 24-hour download window"
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <KpiCard label="Total" value={rows.length.toString()} />
        <KpiCard label="Running" value={running.toString()} hint="pending or in flight" />
        <KpiCard label="Completed" value={completed.toString()} hint="downloadable" />
        <KpiCard label="Failed" value={failed.toString()} />
      </div>

      <SectionCard title="New export">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
          <label className="block w-full sm:w-auto">
            <span className="h-section block mb-1.5">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
              className="w-full sm:w-auto bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent min-h-[44px]"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-auto">
            <span className="h-section block mb-1.5">Format</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as (typeof FORMATS)[number])}
              className="w-full sm:w-auto bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent min-h-[44px]"
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="w-full sm:w-auto px-4 py-2 min-h-[44px] rounded-md bg-accent text-surface text-sm font-medium disabled:opacity-50 hover:bg-accent/90"
          >
            {create.isPending ? 'Queueing…' : 'Start export'}
          </button>
          <span className="text-[11px] text-muted">
            runs asynchronously · poll this page or use the API
          </span>
        </div>
      </SectionCard>

      <SectionCard
        title={`${rows.length} export${rows.length === 1 ? '' : 's'}`}
        subtitle="auto-refreshes every 5s"
        bodyClassName="p-0"
      >
        {/* Mobile < md — stacked cards */}
        <MobileCardList>
          {rows.length === 0 && (
            <div className="text-muted text-sm py-6 text-center">No exports yet.</div>
          )}
          {rows.map((r) => (
            <MobileCardRow
              key={`m-${r.id}`}
              title={r.type.replace(/_/g, ' ')}
              subtitle={`${r.format} · ${formatDateTime(r.createdAt)}`}
              badge={<StatusPill>{r.status}</StatusPill>}
              fields={[
                {
                  label: 'Rows',
                  value: r.rowCount != null ? formatNumber(r.rowCount) : '—',
                },
                {
                  label: 'Size',
                  value: r.fileBytes != null ? `${(r.fileBytes / 1024).toFixed(1)} KB` : '—',
                  align: 'right',
                },
              ]}
              footer={
                r.status === 'COMPLETED' ? (
                  <a
                    href={`${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1/exports/${r.id}/download`}
                    className="inline-flex items-center min-h-[44px] py-2 text-accent hover:underline"
                  >
                    Download ↓
                  </a>
                ) : r.status === 'FAILED' && r.error ? (
                  <span className="text-danger">{r.error}</span>
                ) : r.expiresAt ? (
                  `Expires ${formatDateTime(r.expiresAt)}`
                ) : undefined
              }
            />
          ))}
        </MobileCardList>

        {/* Desktop ≥ md */}
        <div className="hidden md:block overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Created</th>
                <th>Type</th>
                <th>Format</th>
                <th>Status</th>
                <th className="text-right">Rows</th>
                <th className="text-right">Size</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="numeric text-muted text-xs">{formatDateTime(r.createdAt)}</td>
                  <td className="text-xs text-ink">{r.type.replace(/_/g, ' ')}</td>
                  <td>
                    <span className="tag">{r.format}</span>
                  </td>
                  <td>
                    <StatusPill>{r.status}</StatusPill>
                  </td>
                  <td className="numeric text-right text-ink2">
                    {r.rowCount != null ? formatNumber(r.rowCount) : '—'}
                  </td>
                  <td className="numeric text-right text-ink2">
                    {r.fileBytes != null ? `${(r.fileBytes / 1024).toFixed(1)} KB` : '—'}
                  </td>
                  <td className="text-xs text-muted">
                    {r.expiresAt ? formatDateTime(r.expiresAt) : '—'}
                  </td>
                  <td className="text-right">
                    {r.status === 'COMPLETED' && (
                      <a
                        href={`${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1/exports/${r.id}/download`}
                        className="text-[11px] text-accent hover:underline"
                      >
                        Download ↓
                      </a>
                    )}
                    {r.status === 'FAILED' && r.error && (
                      <span className="text-[11px] text-danger" title={r.error}>
                        error
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted py-8 text-center">
                    No exports yet.
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
