'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface TagRow {
  id: string;
  name: string;
  color: string;
  description: string | null;
  assignmentCount: number;
  createdAt: string;
}

const COLORS = ['slate', 'blue', 'navy', 'red', 'amber', 'green', 'purple'] as const;

export default function TagsPage(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tags'], queryFn: () => api<TagRow[]>('/tags') });

  const [name, setName] = useState('');
  const [color, setColor] = useState<(typeof COLORS)[number]>('slate');
  const [desc, setDesc] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/tags', {
        method: 'POST',
        body: JSON.stringify({ name, color, description: desc || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tags'] });
      setName('');
      setDesc('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/tags/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  });

  const rows = q.data ?? [];
  const totalAssigned = rows.reduce((s, t) => s + t.assignmentCount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tags"
        subtitle="Cross-resource organisation. Attach to customers, partners, applications, or cases."
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Tags" value={rows.length.toString()} />
        <KpiCard label="Active assignments" value={totalAssigned.toString()} />
        <KpiCard label="Colors available" value={COLORS.length.toString()} />
      </div>

      <SectionCard title="New tag" subtitle="Lowercase, digits, dashes only.">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <label className="block">
            <span className="h-section block mb-1.5">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="vip-partner"
              className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="h-section block mb-1.5">Color</span>
            <select
              value={color}
              onChange={(e) => setColor(e.target.value as (typeof COLORS)[number])}
              className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block md:col-span-1">
            <span className="h-section block mb-1.5">Description (optional)</span>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="e.g. flagged for fraud review"
              className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name}
            className="px-4 py-2 rounded-md bg-accent text-surface text-sm font-medium disabled:opacity-50 hover:bg-accent/90"
          >
            {create.isPending ? 'Saving…' : 'Create tag'}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={`${rows.length} tag${rows.length === 1 ? '' : 's'}`} bodyClassName="p-0">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Color</th>
              <th>Description</th>
              <th className="text-right">Assignments</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <span className="tag">{t.name}</span>
                </td>
                <td className="text-xs text-ink2">{t.color}</td>
                <td className="text-xs text-muted">{t.description ?? ''}</td>
                <td className="numeric text-right text-ink2">{t.assignmentCount}</td>
                <td className="text-right">
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${t.name}". Removes all assignments.`))
                        remove.mutate(t.id);
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
                <td colSpan={5} className="text-muted py-8 text-center">
                  No tags yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}
