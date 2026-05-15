'use client';

/**
 * /lenders/submit — operator surface for forcing a single application
 * to a single lender (GAP-101 UI).
 *
 * Use case: a customer-success operator is debugging a stuck application
 * and wants to retry the lender call manually. The form takes:
 *   - applicationId (uuid)
 *   - lender slug (picked from the registered adapter list)
 *   - requested amount (decimal string)
 *
 * On submit the dashboard POSTs /lenders/submit. The route is gated by
 * ADMIN/OPERATOR + CSRF. Returns the new LenderDecision row's id +
 * initial decision.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

interface AdapterRow {
  slug: string;
  displayName: string;
  tier: string;
  ready: boolean;
}

interface SubmitResponse {
  decisionId: string;
  externalDecisionId: string | null;
  lenderName: string;
  decision: 'APPROVED' | 'DECLINED' | 'PENDING';
}

export default function LenderSubmitPage(): JSX.Element {
  const adapters = useQuery({
    queryKey: ['lenders', 'adapters'],
    queryFn: () => api<AdapterRow[]>('/lenders/adapters'),
  });
  const [applicationId, setApplicationId] = useState('');
  const [lenderSlug, setLenderSlug] = useState('mock');
  const [requestedAmount, setRequestedAmount] = useState('10000');
  const submit = useMutation({
    mutationFn: () =>
      api<SubmitResponse>('/lenders/submit', {
        method: 'POST',
        body: JSON.stringify({ applicationId, lenderSlug, requestedAmount }),
      }),
  });

  const valid =
    /^[0-9a-f-]{36}$/i.test(applicationId) &&
    lenderSlug.length > 0 &&
    /^\d+(\.\d{1,2})?$/.test(requestedAmount);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Submit to lender"
        subtitle="Force-submit one application to one lender. Used by customer-success to retry a stuck application; admin / operator only."
      />

      <SectionCard title="Submit form">
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-zinc-500" htmlFor="appid">
              Application id (uuid)
            </label>
            <input
              id="appid"
              type="text"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 font-mono"
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              placeholder="00000000-0000-7000-8000-000000000000"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500" htmlFor="lender">
              Lender
            </label>
            <select
              id="lender"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1"
              value={lenderSlug}
              onChange={(e) => setLenderSlug(e.target.value)}
              disabled={adapters.isLoading}
            >
              {(adapters.data ?? []).map((a) => (
                <option key={a.slug} value={a.slug} disabled={!a.ready}>
                  {a.displayName} ({a.slug}) {a.ready ? '' : '· not ready'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500" htmlFor="amount">
              Requested amount
            </label>
            <input
              id="amount"
              type="text"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 font-mono"
              value={requestedAmount}
              onChange={(e) => setRequestedAmount(e.target.value)}
              placeholder="10000"
              inputMode="decimal"
            />
          </div>
          <div className="pt-2">
            <button
              type="button"
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              disabled={!valid || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Submitting…' : 'Submit'}
            </button>
          </div>
          {submit.isError && (
            <p className="text-sm text-red-600">
              {submit.error instanceof ApiError ? submit.error.message : 'Submission failed.'}
            </p>
          )}
          {submit.data && (
            <div className="rounded bg-green-50 p-3 text-xs">
              <p className="font-medium text-green-900">Submitted to {submit.data.lenderName}</p>
              <p className="mt-1">
                Initial decision: <StatusPill>{submit.data.decision}</StatusPill>
              </p>
              <p className="mt-1">
                Decision id: <span className="font-mono">{submit.data.decisionId}</span>
              </p>
              {submit.data.externalDecisionId && (
                <p>
                  External id: <span className="font-mono">{submit.data.externalDecisionId}</span>
                </p>
              )}
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
