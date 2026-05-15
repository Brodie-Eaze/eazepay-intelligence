'use client';

/**
 * /lenders/adapters — registered lender adapters (GAP-101 UI).
 *
 * Read-only list of every adapter the running process knows about,
 * with readiness + tier. Operators use this to confirm a new adapter
 * landed after deploy.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

interface AdapterRow {
  slug: string;
  displayName: string;
  tier: 'PRIME' | 'NEAR_PRIME' | 'SUBPRIME' | 'CARD_LINKED';
  ready: boolean;
}

export default function LenderAdaptersPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['lenders', 'adapters'],
    queryFn: () => api<AdapterRow[]>('/lenders/adapters'),
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Lender adapters"
        subtitle="Adapters registered in this process. A real lender integration is a class implementing LenderAdapter + a register call at boot."
      />

      <SectionCard title={`${q.data?.length ?? 0} registered`}>
        {q.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (q.data ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">No adapters registered.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b">
                <th className="py-2 text-left">Slug</th>
                <th className="text-left">Display name</th>
                <th className="text-left">Tier</th>
                <th className="text-right">Ready</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((a) => (
                <tr key={a.slug} className="border-b last:border-0">
                  <td className="py-2 font-mono text-xs">{a.slug}</td>
                  <td>{a.displayName}</td>
                  <td>{a.tier}</td>
                  <td className="text-right">
                    <StatusPill>{a.ready ? 'ready' : 'pending'}</StatusPill>
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
