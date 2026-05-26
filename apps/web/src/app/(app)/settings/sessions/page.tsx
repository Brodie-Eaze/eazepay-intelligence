'use client';

/**
 * /settings/sessions — Phase 4c session management UI.
 *
 * Lists every active refresh-token session for the current user and lets
 * them revoke individual sessions. Bound to the new
 * GET /auth/sessions + DELETE /auth/sessions/:id backend.
 *
 * UX rules:
 *   - The current session is flagged + the revoke button is disabled
 *     for it (revoking would log the user out mid-page, which is
 *     possible but should require an explicit "log out of this device"
 *     button elsewhere).
 *   - Confirm before revoking — once gone, the user has to log in again
 *     on the affected device.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface SessionRow {
  sessionId: string;
  orgId: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

interface SessionsResponse {
  sessions: SessionRow[];
}

export default function SessionsPage(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => api<SessionsResponse>('/auth/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (sessionId: string) =>
      api<void>(`/auth/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'sessions'] }),
  });

  const rows = q.data?.sessions ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Active sessions"
        subtitle="Every device currently signed in to your account. Revoking a session forces that device to sign in again."
      />

      <SectionCard title="Sessions">
        {q.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-zinc-500">No active sessions.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b">
                <th className="py-2 text-left">Session</th>
                <th className="text-left">Org</th>
                <th className="text-left">Started</th>
                <th className="text-left">Expires</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.sessionId} className="border-b last:border-0">
                  <td className="py-2 font-mono text-xs">
                    {s.sessionId.slice(0, 8)}…
                    {s.current && (
                      <span className="ml-2">
                        <StatusPill>this device</StatusPill>
                      </span>
                    )}
                  </td>
                  <td className="font-mono text-xs">{s.orgId.slice(0, 8)}…</td>
                  <td>{formatDateTime(s.createdAt)}</td>
                  <td>{formatDateTime(s.expiresAt)}</td>
                  <td className="text-right">
                    <ConfirmDialog
                      title="Revoke this session"
                      body="The device using this session is signed out on its next request."
                      danger
                      confirmLabel="Revoke"
                      onConfirm={() => revoke.mutate(s.sessionId)}
                      trigger={(open) => (
                        <button
                          className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                          disabled={s.current || revoke.isPending}
                          onClick={open}
                          type="button"
                        >
                          Revoke
                        </button>
                      )}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {revoke.isError && (
        <p className="text-sm text-red-600">
          {revoke.error instanceof ApiError ? revoke.error.message : 'Couldn’t revoke that session. Try again.'}
        </p>
      )}
    </div>
  );
}
