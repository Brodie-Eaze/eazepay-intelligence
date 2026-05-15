'use client';

/**
 * /platform/orgs/[id] — tenant detail + SUPER actions.
 *
 * Three destructive actions, each MFA-step-up gated:
 *   1. Issue impersonation token (cross-tenant access, 30-min cap)
 *   2. Offboard (soft-delete → archive → cryptoshred → purge)
 *   3. Cryptoshred (raw DEK destruction; requires prior soft-delete)
 *
 * Every action runs through `useMfaStepUp()` so a 403/MFA_STEP_UP_REQUIRED
 * response triggers the modal + auto-retry.
 */
import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MfaStepUpModal, useMfaStepUp } from '@/components/MfaStepUpModal';

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  dataRegion: string;
  stripeCustomerId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ImpersonateResponse {
  token: string;
  expiresIn: number;
  org: { id: string; slug: string; name: string };
  sid: string;
}

export default function PlatformOrgDetailPage(props: {
  params: Promise<{ id: string }>;
}): JSX.Element {
  // Next.js 14 stable params handling.
  const { id } = use(props.params);
  const qc = useQueryClient();
  const { withMfaStepUp, modalProps } = useMfaStepUp();
  const [reason, setReason] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [issuedToken, setIssuedToken] = useState<ImpersonateResponse | null>(null);

  const q = useQuery({
    queryKey: ['platform', 'org', id],
    queryFn: () => api<OrgRow>(`/platform/orgs/${id}`),
  });

  const issueImpersonate = useMutation({
    mutationFn: async (): Promise<ImpersonateResponse> =>
      withMfaStepUp(() =>
        api<ImpersonateResponse>(`/platform/orgs/${id}/impersonate-token`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim() }),
        }),
      ),
    onSuccess: (data) => setIssuedToken(data),
  });

  const offboard = useMutation({
    mutationFn: async () =>
      withMfaStepUp(() =>
        api<unknown>(`/platform/orgs/${id}/offboard`, {
          method: 'POST',
          headers: { 'X-Offboard-Confirm': confirmSlug },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'org', id] }),
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={q.data ? `Org · ${q.data.name}` : 'Org'}
        subtitle={q.data ? `Slug: ${q.data.slug} · region: ${q.data.dataRegion}` : 'Loading…'}
      />

      <SectionCard title="Overview">
        {q.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : q.isError ? (
          <p className="text-sm text-red-600">Failed to load org.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-zinc-500">Org id</dt>
            <dd className="font-mono text-xs">{q.data!.id}</dd>
            <dt className="text-zinc-500">Slug</dt>
            <dd className="font-mono">{q.data!.slug}</dd>
            <dt className="text-zinc-500">Members</dt>
            <dd>{q.data!.memberCount}</dd>
            <dt className="text-zinc-500">Created</dt>
            <dd>{formatDateTime(q.data!.createdAt)}</dd>
            <dt className="text-zinc-500">Stripe customer</dt>
            <dd className="font-mono">{q.data!.stripeCustomerId ?? '—'}</dd>
          </dl>
        )}
      </SectionCard>

      <SectionCard title="Issue impersonation token">
        <p className="text-sm text-zinc-600">
          Mint a short-lived (≤30 min) access token pinned to this org. Audit-logged with reason.
        </p>
        <div className="mt-3 space-y-2">
          <textarea
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
            placeholder="Reason (required, ≥8 chars)"
            value={reason}
            rows={2}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            disabled={reason.trim().length < 8 || issueImpersonate.isPending}
            type="button"
            onClick={() => issueImpersonate.mutate()}
          >
            {issueImpersonate.isPending ? 'Issuing…' : 'Issue token'}
          </button>
          {issueImpersonate.isError && (
            <p className="text-sm text-red-600">
              {issueImpersonate.error instanceof ApiError
                ? issueImpersonate.error.message
                : 'Failed to issue token.'}
            </p>
          )}
          {issuedToken && (
            <div className="rounded bg-amber-50 p-3 text-xs">
              <p className="font-semibold text-amber-900">
                Token issued — expires in {issuedToken.expiresIn}s
              </p>
              <p className="mt-1">
                sid: <span className="font-mono">{issuedToken.sid}</span>
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer">Show raw access token</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[10px]">
                  {issuedToken.token}
                </pre>
              </details>
              <p className="mt-2 text-amber-700">
                Revoke this session via /settings/sessions if you finish early.
              </p>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Offboard tenant">
        <p className="text-sm text-zinc-600">
          Soft-delete → archive evidence → cryptoshred DEK → purge outbox → quarantine remaining
          webhook events. Irreversible.
        </p>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            placeholder={`Type "${q.data?.slug ?? '<slug>'}" to confirm`}
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm font-mono"
            value={confirmSlug}
            onChange={(e) => setConfirmSlug(e.target.value)}
          />
          <ConfirmDialog
            title="Offboard this tenant?"
            body={
              <>
                <p>
                  Soft-deletes the org, archives evidence to export storage, cryptoshreds the DEK,
                  purges outbox rows, quarantines remaining webhook events.
                </p>
                <p className="mt-2 font-medium text-red-700">
                  This is irreversible. Make sure billing + commercial sign-off is on file.
                </p>
              </>
            }
            danger
            confirmLabel="Offboard tenant"
            onConfirm={() => offboard.mutate()}
            trigger={(open) => (
              <button
                className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                type="button"
                disabled={!q.data || confirmSlug !== q.data.slug || offboard.isPending}
                onClick={open}
              >
                {offboard.isPending ? 'Offboarding…' : 'Offboard'}
              </button>
            )}
          />
          {offboard.isError && (
            <p className="text-sm text-red-600">
              {offboard.error instanceof ApiError ? offboard.error.message : 'Failed to offboard.'}
            </p>
          )}
          {offboard.isSuccess && (
            <p className="text-sm text-green-700">
              <StatusPill>Offboarded</StatusPill> — archive locator + audit row written.
            </p>
          )}
        </div>
      </SectionCard>

      <MfaStepUpModal {...modalProps} />
    </div>
  );
}
