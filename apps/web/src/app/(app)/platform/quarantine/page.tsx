'use client';

/**
 * /platform/quarantine — Phase H operator triage UI.
 *
 * Renders the quarantined EazePay App webhook events and the outbox DLQ
 * rows in a single table per source. Operators can re-run drains (with
 * optional org reassignment for the EazePay App brand-quarantine case).
 *
 * Routes:
 *   GET    /platform/eazepay-app/quarantine     → list
 *   POST   /platform/eazepay-app/quarantine/:id/replay
 *   GET    /platform/outbox/dlq                  → list
 *   POST   /platform/outbox/dlq/:id/replay
 *
 * All replay routes require MFA step-up — the dashboard intercepts the
 * 403 and surfaces a "verify MFA" prompt, then re-tries.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface QuarantineRow {
  id: string;
  orgId: string;
  eventType: string;
  idempotencyKey: string;
  reason: string | null;
  receivedAt: string;
  brand: string | null;
}

interface DlqRow {
  id: string;
  orgId: string;
  kind: string;
  refType: string | null;
  refId: string | null;
  attemptCount: number;
  publishError: string | null;
  createdAt: string;
  dlqedAt: string | null;
}

export default function QuarantineTriagePage(): JSX.Element {
  const qc = useQueryClient();
  const quarantine = useQuery({
    queryKey: ['platform', 'quarantine'],
    queryFn: () => api<{ rows: QuarantineRow[] }>('/platform/eazepay-app/quarantine'),
  });
  const dlq = useQuery({
    queryKey: ['platform', 'dlq'],
    queryFn: () => api<{ rows: DlqRow[] }>('/platform/outbox/dlq'),
  });

  const replayQuarantine = useMutation({
    mutationFn: (args: { id: string; reassignToOrgId?: string }) =>
      api(`/platform/eazepay-app/quarantine/${args.id}/replay`, {
        method: 'POST',
        body: JSON.stringify(args.reassignToOrgId ? { reassignToOrgId: args.reassignToOrgId } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'quarantine'] }),
  });

  const replayDlq = useMutation({
    mutationFn: (id: string) => api(`/platform/outbox/dlq/${id}/replay`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'dlq'] }),
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Platform · quarantine triage"
        subtitle="Quarantined EazePay App webhooks + outbox DLQ rows. Replay actions require MFA step-up (5-min single-use)."
      />

      <SectionCard title={`EazePay App quarantine (${quarantine.data?.rows.length ?? 0})`}>
        {quarantine.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (quarantine.data?.rows ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">
            Nothing in quarantine — all events drained cleanly.
          </p>
        ) : (
          <QuarantineTable
            rows={quarantine.data!.rows}
            onReplay={(id, orgId) => replayQuarantine.mutate({ id, reassignToOrgId: orgId })}
            pending={replayQuarantine.isPending}
            error={replayQuarantine.error}
          />
        )}
      </SectionCard>

      <SectionCard title={`Outbox DLQ (${dlq.data?.rows.length ?? 0})`}>
        {dlq.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (dlq.data?.rows ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">Outbox DLQ empty.</p>
        ) : (
          <DlqTable
            rows={dlq.data!.rows}
            onReplay={(id) => replayDlq.mutate(id)}
            pending={replayDlq.isPending}
            error={replayDlq.error}
          />
        )}
      </SectionCard>
    </div>
  );
}

function QuarantineTable(props: {
  rows: QuarantineRow[];
  onReplay: (id: string, reassignToOrgId?: string) => void;
  pending: boolean;
  error: unknown;
}): JSX.Element {
  const [reassignBy, setReassignBy] = useState<Record<string, string>>({});
  return (
    <>
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500">
          <tr className="border-b">
            <th className="py-2 text-left">Event</th>
            <th className="text-left">Brand</th>
            <th className="text-left">Reason</th>
            <th className="text-left">Received</th>
            <th className="text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0 align-top">
              <td className="py-2">
                <div className="font-medium">{r.eventType}</div>
                <div className="font-mono text-xs text-zinc-500">{r.idempotencyKey}</div>
              </td>
              <td>{r.brand ?? '—'}</td>
              <td>
                <StatusPill>{r.reason ?? 'unknown'}</StatusPill>
              </td>
              <td>{formatDateTime(r.receivedAt)}</td>
              <td className="text-right space-x-2">
                <input
                  type="text"
                  placeholder="reassign to orgId (optional)"
                  className="rounded border border-zinc-300 px-2 py-1 text-xs"
                  value={reassignBy[r.id] ?? ''}
                  onChange={(e) => setReassignBy((v) => ({ ...v, [r.id]: e.target.value }))}
                />
                <ConfirmDialog
                  title="Replay quarantined event?"
                  body={
                    <>
                      <p>The event will re-enter the drain queue.</p>
                      {(reassignBy[r.id] ?? '').trim() && (
                        <p className="mt-2 font-mono text-xs">
                          Reassign to: {(reassignBy[r.id] ?? '').trim()}
                        </p>
                      )}
                    </>
                  }
                  danger
                  confirmLabel="Replay"
                  onConfirm={() => {
                    const reassign = (reassignBy[r.id] ?? '').trim() || undefined;
                    props.onReplay(r.id, reassign);
                  }}
                  trigger={(open) => (
                    <button
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                      disabled={props.pending}
                      onClick={open}
                      type="button"
                    >
                      Replay
                    </button>
                  )}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.error instanceof ApiError && props.error.code === 'FORBIDDEN' && (
        <p className="mt-3 text-sm text-amber-700">
          MFA step-up required. Verify your TOTP in Settings → MFA, then retry.
        </p>
      )}
    </>
  );
}

function DlqTable(props: {
  rows: DlqRow[];
  onReplay: (id: string) => void;
  pending: boolean;
  error: unknown;
}): JSX.Element {
  return (
    <>
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500">
          <tr className="border-b">
            <th className="py-2 text-left">Kind</th>
            <th className="text-left">Ref</th>
            <th className="text-left">Attempts</th>
            <th className="text-left">Last error</th>
            <th className="text-left">DLQ'd</th>
            <th className="text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0 align-top">
              <td className="py-2 font-medium">{r.kind}</td>
              <td className="font-mono text-xs">
                {r.refType ?? '—'} {r.refId ? `· ${r.refId.slice(0, 8)}…` : ''}
              </td>
              <td>{r.attemptCount}</td>
              <td className="max-w-md truncate text-xs">{r.publishError ?? '—'}</td>
              <td>{r.dlqedAt ? formatDateTime(r.dlqedAt) : '—'}</td>
              <td className="text-right">
                <ConfirmDialog
                  title="Re-queue DLQ row?"
                  body="The row's attempt counter resets and the sweeper picks it up on the next tick. Make sure the root cause is fixed."
                  danger
                  confirmLabel="Re-queue"
                  onConfirm={() => props.onReplay(r.id)}
                  trigger={(open) => (
                    <button
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                      disabled={props.pending}
                      onClick={open}
                      type="button"
                    >
                      Re-queue
                    </button>
                  )}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.error instanceof ApiError && props.error.code === 'FORBIDDEN' && (
        <p className="mt-3 text-sm text-amber-700">
          MFA step-up required. Verify your TOTP in Settings → MFA, then retry.
        </p>
      )}
    </>
  );
}
