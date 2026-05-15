'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

interface AppRow {
  id: string;
  partnerId: string;
  externalApplicationId: string;
  consumerNameMasked: string;
  consumerEmailMasked: string;
  consumerPhoneMasked: string;
  status: string;
  creditScore: number | null;
  createdAt: string;
}

export default function ApplicationsPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['applications.list'],
    queryFn: () => api<{ data: AppRow[]; nextCursor: string | null }>('/applications?limit=100'),
  });

  const rows = q.data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        subtitle="Read-only application ledger · PII masked by default · operator+ only"
      />

      <SectionCard
        title={`${rows.length} most-recent applications`}
        subtitle="Click an ID to open the full timeline"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>External ID</th>
                <th>Consumer</th>
                <th>Email</th>
                <th>Phone</th>
                <th className="text-right">Credit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="numeric text-muted whitespace-nowrap">
                    {formatDateTime(a.createdAt)}
                  </td>
                  <td className="numeric">
                    <code className="kbd">{a.externalApplicationId}</code>
                  </td>
                  <td className="text-ink">{a.consumerNameMasked}</td>
                  <td className="text-muted">{a.consumerEmailMasked}</td>
                  <td className="numeric text-muted">{a.consumerPhoneMasked}</td>
                  <td className="numeric text-right text-ink2">{a.creditScore ?? '—'}</td>
                  <td>
                    <StatusPill>{a.status}</StatusPill>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-muted">
                    No applications yet.
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
