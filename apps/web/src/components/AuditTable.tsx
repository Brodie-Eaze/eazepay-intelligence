'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SectionCard } from './SectionCard';

export interface AuditRow {
  id: string;
  userEmail: string | null;
  userRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface Filter {
  action?: string;
  resourceType?: string;
  /** ISO date (YYYY-MM-DD) — inclusive lower bound on `createdAt`. */
  from?: string;
  /** ISO date (YYYY-MM-DD) — inclusive upper bound on `createdAt`. */
  to?: string;
}

interface Props {
  filter?: Filter;
  title: string;
  subtitle?: string;
  queryKey: ReadonlyArray<string>;
}

export function AuditTable({ filter, title, subtitle, queryKey }: Props): JSX.Element {
  const q = useQuery({
    queryKey: [...queryKey],
    queryFn: () => {
      // Server-side filters supported by the API; date range is applied client-side
      // since the audit endpoint doesn't currently expose from/to params.
      const params = new URLSearchParams();
      if (filter?.action) params.set('action', filter.action);
      if (filter?.resourceType) params.set('resourceType', filter.resourceType);
      params.set('limit', '100');
      return api<AuditRow[]>(`/audit-logs?${params.toString()}`);
    },
    refetchInterval: 30_000,
  });

  const rows = useMemo(() => {
    const all = q.data ?? [];
    const from = filter?.from;
    const to = filter?.to;
    if (!from && !to) return all;
    return all.filter((r) => {
      if (from && r.createdAt < from) return false;
      if (to && r.createdAt.slice(0, 10) > to) return false;
      return true;
    });
  }, [q.data, filter?.from, filter?.to]);

  return (
    <SectionCard
      title={title}
      subtitle={subtitle ?? `${rows.length} most-recent events`}
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Resource</th>
              <th>Metadata</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="numeric text-muted whitespace-nowrap">
                  {formatDateTime(r.createdAt)}
                </td>
                <td className="numeric">
                  <code className="kbd">{r.action}</code>
                </td>
                <td>
                  {r.userEmail ? (
                    <div>
                      <div className="text-ink text-sm">{r.userEmail}</div>
                      <div className="text-[11px] text-muted">{r.userRole}</div>
                    </div>
                  ) : (
                    <span className="text-muted text-sm">system</span>
                  )}
                </td>
                <td>
                  <div className="text-ink2 text-sm">{r.resourceType}</div>
                  {r.resourceId && (
                    <div className="text-[11px] text-muted truncate max-w-[180px]">
                      <code>{r.resourceId}</code>
                    </div>
                  )}
                </td>
                <td className="text-[11px] text-muted truncate max-w-[300px]">
                  <code>{JSON.stringify(r.metadata ?? {})}</code>
                </td>
                <td className="numeric text-muted">{r.ipAddress ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted py-8 text-center">
                  No audit entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
