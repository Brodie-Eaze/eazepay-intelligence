'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface AppRow {
  id: string;
  partnerId: string;
  externalApplicationId: string;
  consumerNameMasked: string;
  consumerEmailMasked: string;
  status: string;
  creditScore: number | null;
  createdAt: string;
}

const STATUSES = ['PENDING', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'DECLINED', 'FUNDED'] as const;

export default function AppsByStatusPage(): JSX.Element {
  // STATUSES is a frozen `as const` array — the iteration order + count
  // never changes between renders, so hooks-in-loop is safe here despite
  // the lint rule. The rule is appropriately conservative; this is the
  // documented exception.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const queries = STATUSES.map((s) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useQuery({
      queryKey: ['applications.by-status', s],
      queryFn: () => api<{ data: AppRow[] }>(`/applications?status=${s}&limit=20`),
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications · by status"
        subtitle="The funnel sliced into queues · each column is a state"
      />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {STATUSES.map((s, i) => (
          <KpiCard
            key={s}
            label={s}
            value={(queries[i]!.data?.data?.length ?? 0).toString()}
            hint="last 20 in state"
          />
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {STATUSES.map((s, i) => {
          const rows = queries[i]!.data?.data ?? [];
          return (
            <SectionCard
              key={s}
              title={s}
              subtitle={`${rows.length} application${rows.length === 1 ? '' : 's'}`}
              bodyClassName="p-0"
            >
              <ul className="divide-y divide-line max-h-[420px] overflow-auto">
                {rows.map((a) => (
                  <li key={a.id} className="px-4 py-2.5 hover:bg-paper/60">
                    <Link href={`/applications/${a.id}`} className="block">
                      <div className="flex items-center justify-between text-sm">
                        <code className="kbd">{a.externalApplicationId}</code>
                        <StatusPill>{a.status}</StatusPill>
                      </div>
                      <div className="mt-1 text-[11px] text-muted">
                        {a.consumerNameMasked} · {a.consumerEmailMasked}
                      </div>
                      <div className="mt-1 text-[11px] text-muted numeric">
                        credit {a.creditScore ?? '—'} · {formatDateTime(a.createdAt)}
                      </div>
                    </Link>
                  </li>
                ))}
                {rows.length === 0 && (
                  <li className="px-4 py-6 text-center text-muted text-sm">empty</li>
                )}
              </ul>
            </SectionCard>
          );
        })}
      </div>
    </div>
  );
}
