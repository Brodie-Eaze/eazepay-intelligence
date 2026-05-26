'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';

interface Hit {
  kind: 'customer' | 'partner' | 'application' | 'lender';
  id: string;
  label: string;
  sub: string | null;
  href: string;
}

export default function SearchPage(): JSX.Element {
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<{ query: string; hits: Hit[] }>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
  });

  const hits = search.data?.hits ?? [];
  const grouped = hits.reduce<Record<string, Hit[]>>((acc, h) => {
    acc[h.kind] = acc[h.kind] ?? [];
    acc[h.kind]!.push(h);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageHeader
        title="Search"
        subtitle="Across customers · partners · applications · lenders. Type at least 2 characters."
      />

      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by partner name, application ID, lender, or customer hash prefix…"
        className="w-full h-12 bg-surface border border-line rounded-lg px-4 text-base outline-none focus:border-accent focus:ring-4 focus:ring-accentSoft transition"
      />

      {q.trim().length < 2 && (
        <div className="card card-pad text-sm text-muted">
          Type to search. Try a partner name, an application external ID, a lender name, or the
          first hex characters of a customer hash.
        </div>
      )}

      {q.trim().length >= 2 && search.isLoading && <div className="text-muted">Searching…</div>}

      {q.trim().length >= 2 && hits.length === 0 && !search.isLoading && (
        <EmptyState
          variant="searchEmpty"
          title="No matches"
          description={
            <>
              Nothing indexed under <code className="tag">{q}</code>. Try a partner name, an
              application external ID, a lender, or the first hex of a customer hash.
            </>
          }
        />
      )}

      {(['partner', 'application', 'lender', 'customer'] as const).map((kind) => {
        const items = grouped[kind] ?? [];
        if (items.length === 0) return null;
        return (
          <SectionCard
            key={kind}
            title={`${kind.charAt(0).toUpperCase()}${kind.slice(1)}s`}
            subtitle={`${items.length} match${items.length === 1 ? '' : 'es'}`}
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-line2">
              {items.map((h) => (
                <li key={`${h.kind}-${h.id}`} className="px-5 py-3 hover:bg-paper/70">
                  <Link href={h.href} className="block">
                    <div className="flex items-center gap-2">
                      <StatusPill>{h.kind.toUpperCase()}</StatusPill>
                      <span className="text-ink font-medium">{h.label}</span>
                    </div>
                    {h.sub && <div className="text-xs text-muted mt-1">{h.sub}</div>}
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        );
      })}
    </div>
  );
}
