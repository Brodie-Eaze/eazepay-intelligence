'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { Monogram } from '@/components/Monogram';

interface Sess {
  id: string;
  userEmail: string;
  userRole: string;
  familyId: string;
  createdAt: string;
  expiresAt: string;
}

export default function SessionsPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['ops.sessions'],
    queryFn: () => api<Sess[]>('/admin/sessions'),
    refetchInterval: 30_000,
  });

  const rows = q.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Active sessions"
        subtitle="Every live refresh-token family · revoke on theft detection happens automatically"
      />
      <SectionCard title={`${rows.length} active`} subtitle="ordered by created_at desc" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Family</th>
                <th>Issued</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Monogram label={r.userEmail} />
                      <span className="text-ink">{r.userEmail}</span>
                    </div>
                  </td>
                  <td><StatusPill>{r.userRole}</StatusPill></td>
                  <td className="text-[11px] text-muted"><code>{r.familyId.slice(0, 12)}…</code></td>
                  <td className="numeric text-muted">{formatDateTime(r.createdAt)}</td>
                  <td className="numeric text-muted">{formatDateTime(r.expiresAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="text-muted py-8 text-center">No active sessions.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
