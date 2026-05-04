'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { Monogram } from '@/components/Monogram';
import { KpiCard } from '@/components/KpiCard';
import { useUser } from '@/lib/auth';

interface UserRow {
  id: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'VIEWER';
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
}

const ROLES = ['ADMIN', 'OPERATOR', 'INVESTOR', 'VIEWER'] as const;

export default function UsersPage(): JSX.Element {
  const me = useUser();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });

  const [showForm, setShowForm] = useState(false);
  const [draftEmail, setDraftEmail] = useState('');
  const [draftPassword, setDraftPassword] = useState('');
  const [draftRole, setDraftRole] = useState<typeof ROLES[number]>('VIEWER');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: { email: string; password: string; role: string }) =>
      api<UserRow>('/users', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setShowForm(false);
      setDraftEmail(''); setDraftPassword(''); setDraftRole('VIEWER');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed'),
  });

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const rows = q.data ?? [];
  const counts = rows.reduce<Record<string, number>>((a, r) => { a[r.role] = (a[r.role] ?? 0) + 1; return a; }, {});
  const totalSessions = rows.reduce((s, r) => s + r.activeSessions, 0);
  const mfaCount = rows.filter((r) => r.mfaEnabled).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & roles"
        subtitle="Operator access · MFA enforcement · session inventory"
        action={
          <button
            onClick={() => { setShowForm(!showForm); setError(null); }}
            className="text-xs px-3 py-1.5 rounded-md bg-ink text-surface font-medium hover:bg-ink2 transition"
          >
            {showForm ? 'Cancel' : '+ New user'}
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Users" value={rows.length.toString()} hint={`${counts.ADMIN ?? 0} admin · ${counts.OPERATOR ?? 0} operator`} />
        <KpiCard label="Active sessions" value={totalSessions.toString()} hint="across all users" />
        <KpiCard label="MFA enabled" value={mfaCount.toString()} hint={`${rows.length ? Math.round((mfaCount / rows.length) * 100) : 0}% coverage`} />
        <KpiCard label="Viewers" value={(counts.VIEWER ?? 0).toString()} hint="read-only" />
      </div>

      {showForm && (
        <SectionCard title="Invite a new user" subtitle="they'll receive a temporary password to share securely">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <Field label="Email">
              <input
                type="email"
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
                placeholder="user@eazepay.local"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="Password">
              <input
                type="text"
                value={draftPassword}
                onChange={(e) => setDraftPassword(e.target.value)}
                placeholder="min 8 chars"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="Role">
              <select
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value as typeof ROLES[number])}
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <button
              onClick={() => {
                setError(null);
                create.mutate({ email: draftEmail, password: draftPassword, role: draftRole });
              }}
              disabled={create.isPending || !draftEmail || draftPassword.length < 8}
              className="px-4 py-2 rounded-md bg-accent text-surface text-sm font-medium disabled:opacity-50 hover:bg-accent/90"
            >
              {create.isPending ? 'Creating…' : 'Create user'}
            </button>
          </div>
          {error && <div className="text-xs text-danger mt-3">{error}</div>}
        </SectionCard>
      )}

      <SectionCard title={`${rows.length} users`} subtitle="active accounts · soft-delete preserves audit trail" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>MFA</th>
                <th className="text-right">Sessions</th>
                <th>Last login</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Monogram label={u.email} />
                        <div>
                          <div className="text-ink font-medium tracking-tight">{u.email}</div>
                          {isMe && <div className="text-[11px] text-accent">that's you</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      {isMe ? (
                        <StatusPill>{u.role}</StatusPill>
                      ) : (
                        <select
                          value={u.role}
                          onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value })}
                          disabled={setRole.isPending}
                          className="text-xs bg-paper border border-line rounded-md px-2 py-1 outline-none focus:border-accent"
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      )}
                    </td>
                    <td>{u.mfaEnabled ? <span className="pill pill-success">On</span> : <span className="pill pill-muted">Off</span>}</td>
                    <td className="numeric text-right text-ink2">{u.activeSessions}</td>
                    <td className="numeric text-muted text-xs">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'never'}</td>
                    <td className="numeric text-muted text-xs">{formatDateTime(u.createdAt)}</td>
                    <td className="text-right">
                      {!isMe && (
                        <button
                          onClick={() => { if (confirm(`Soft-delete ${u.email}? Sessions revoked. Audit log preserved.`)) remove.mutate(u.id); }}
                          className="text-[11px] text-danger hover:underline"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={7} className="text-muted py-8 text-center">No users.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="h-section block mb-1.5">{label}</span>
      {children}
    </label>
  );
}
