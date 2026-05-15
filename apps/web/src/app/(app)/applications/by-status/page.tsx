'use client';

import { useQueries } from '@tanstack/react-query';
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
  // Use `useQueries` (TanStack Query's plural form) — a SINGLE hook call
  // that fans out into N parallel queries. This is the canonical pattern
  // for "render one query per item in a fixed list" and removes the
  // hooks-in-loop concern entirely. Earlier code used `STATUSES.map(s =>
  // useQuery(...))` which works because the array is `as const` but
  // requires `eslint-disable react-hooks/rules-of-hooks` — bad signal.
  const queries = useQueries({
    queries: STATUSES.map((s) => ({
      queryKey: ['applications.by-status', s],
      queryFn: () => api<{ data: AppRow[] }>(`/applications?status=${s}&limit=20`),
    })),
  });

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
