'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: ('READ' | 'WRITE' | 'ADMIN')[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  isActive: boolean;
}

interface TokenCreated extends TokenRow {
  token: string;
}

const SCOPES = ['READ', 'WRITE', 'ADMIN'] as const;

export default function TokensPage(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['api-tokens'], queryFn: () => api<TokenRow[]>('/api-tokens') });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<(typeof SCOPES)[number][]>(['READ']);
  const [expDays, setExpDays] = useState<number | ''>('');
  const [reveal, setReveal] = useState<TokenCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: { name: string; scopes: string[]; expiresInDays?: number }) =>
      api<TokenCreated>('/api-tokens', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
      setReveal(data);
      setShowForm(false);
      setName('');
      setScopes(['READ']);
      setExpDays('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  });

  const rows = q.data ?? [];
  const active = rows.filter((r) => r.isActive).length;
  const expired = rows.filter(
    (r) => r.expiresAt && new Date(r.expiresAt).getTime() < Date.now(),
  ).length;
  const revoked = rows.filter((r) => r.revokedAt).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="API tokens"
        subtitle="Programmatic access · service-to-service · BI integrations"
        action={
          <button
            onClick={() => {
              setShowForm(!showForm);
              setError(null);
              setReveal(null);
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-ink text-surface font-medium hover:bg-ink2 transition"
          >
            {showForm ? 'Cancel' : '+ New token'}
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Total" value={rows.length.toString()} hint={`${active} active`} />
        <KpiCard label="Active" value={active.toString()} hint="not revoked, not expired" />
        <KpiCard label="Expired" value={expired.toString()} hint="past TTL" />
        <KpiCard label="Revoked" value={revoked.toString()} hint="manually disabled" />
      </div>

      {reveal && (
        <SectionCard
          title="Token issued — copy now"
          subtitle="This is the only time we'll show the secret. Store it in your vault."
        >
          <div className="bg-paper border border-line rounded-md p-3 font-mono text-sm break-all">
            {reveal.token}
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(reveal.token)}
            className="mt-3 text-xs px-3 py-1.5 rounded-md border border-line hover:bg-paper"
          >
            Copy to clipboard
          </button>
          <button
            onClick={() => setReveal(null)}
            className="ml-2 text-xs text-muted hover:text-ink"
          >
            I&apos;ve saved it
          </button>
        </SectionCard>
      )}

      {showForm && (
        <SectionCard
          title="Issue a new token"
          subtitle="Choose scopes carefully — write tokens can mutate data on your behalf"
        >
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <label className="block">
              <span className="h-section block mb-1.5">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Looker prod"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="h-section block mb-1.5">Scopes</span>
              <div className="flex gap-1">
                {SCOPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() =>
                      setScopes((cur) =>
                        cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
                      )
                    }
                    className={`px-3 py-1.5 text-xs rounded-md border ${scopes.includes(s) ? 'border-accent text-accent bg-accentSoft' : 'border-line text-ink2 hover:bg-paper'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </label>
            <label className="block">
              <span className="h-section block mb-1.5">Expires (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={expDays}
                onChange={(e) => setExpDays(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="never"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <button
              onClick={() =>
                create.mutate({
                  name,
                  scopes,
                  ...(typeof expDays === 'number' ? { expiresInDays: expDays } : {}),
                })
              }
              disabled={create.isPending || !name || scopes.length === 0}
              className="px-4 py-2 rounded-md bg-accent text-surface text-sm font-medium disabled:opacity-50 hover:bg-accent/90"
            >
              {create.isPending ? 'Creating…' : 'Issue token'}
            </button>
          </div>
          {error && <div className="text-xs text-danger mt-3">{error}</div>}
        </SectionCard>
      )}

      <SectionCard
        title={`${rows.length} token${rows.length === 1 ? '' : 's'}`}
        subtitle="latest first"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="font-medium text-ink">{t.name}</td>
                  <td>
                    <span className="tag">{t.prefix}</span>
                  </td>
                  <td className="text-xs text-ink2">{t.scopes.join(', ')}</td>
                  <td className="text-xs text-muted">
                    {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : 'never'}
                  </td>
                  <td className="text-xs text-muted">
                    {t.expiresAt ? formatDateTime(t.expiresAt) : 'never'}
                  </td>
                  <td>
                    {t.revokedAt ? (
                      <StatusPill>INACTIVE</StatusPill>
                    ) : t.isActive ? (
                      <StatusPill>ACTIVE</StatusPill>
                    ) : (
                      <StatusPill>INACTIVE</StatusPill>
                    )}
                  </td>
                  <td className="text-right">
                    {!t.revokedAt && (
                      <button
                        onClick={() => {
                          if (
                            confirm(
                              `Revoke token "${t.name}"? Calls using it will start failing immediately.`,
                            )
                          )
                            revoke.mutate(t.id);
                        }}
                        className="text-[11px] text-danger hover:underline"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted py-8 text-center">
                    No tokens yet. Issue one to get started.
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
