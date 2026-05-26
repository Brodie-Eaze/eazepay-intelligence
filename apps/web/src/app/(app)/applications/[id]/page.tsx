'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatMoney, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { Monogram } from '@/components/Monogram';
import { KpiCard } from '@/components/KpiCard';

interface Timeline {
  application: {
    id: string;
    externalApplicationId: string;
    status: string;
    submittedAt: string | null;
    createdAt: string;
    updatedAt: string;
    enrichment: {
      creditScore: number | null;
      availableCredit: string | null;
      notedAnnualIncome: string | null;
      bankStatementsProvided: boolean;
      merchantPreapproval: boolean;
      merchantPreapprovalAmount: string | null;
      consumerPreapproval: boolean;
      consumerPreapprovalAmount: string | null;
      fundingEstimate: string | null;
      propensityScore: string | null;
      openLinesOfCredit: number | null;
    };
  };
  partner: { id: string; name: string; tier: string; externalId: string };
  decisions: Array<{
    id: string;
    lenderName: string;
    lenderTier: string;
    decision: string;
    decisionTimestamp: string;
    approvalAmount: string | null;
    apr: string | null;
    term: number | null;
    monthlyPayment: string | null;
    originationFee: string | null;
    fundingStatus: string;
    fundingTimestamp: string | null;
    fundingAmount: string | null;
  }>;
  revenueEvents: Array<{
    idempotencyKey: string;
    stream: string;
    eventType: string;
    amount: string;
    effectiveAt: string;
  }>;
}

interface PiiResp { id: string; consumerName: string; consumerEmail: string; consumerPhone: string }

export default function ApplicationDetail({ params }: { params: { id: string } }): JSX.Element {
  const [pii, setPii] = useState<PiiResp | null>(null);
  const [piiBusy, setPiiBusy] = useState(false);
  const [piiError, setPiiError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['application.timeline', params.id],
    queryFn: () => api<Timeline>(`/applications/${params.id}/timeline`),
  });

  const revealPii = async (): Promise<void> => {
    setPiiBusy(true); setPiiError(null);
    try {
      const r = await api<PiiResp>(`/applications/${params.id}/pii`, { method: 'GET' });
      setPii(r);
    } catch (err) {
      setPiiError(err instanceof ApiError ? err.message : 'Couldn’t reveal PII. Try again.');
    } finally {
      setPiiBusy(false);
    }
  };

  if (q.isLoading) return <div className="text-muted">Loading…</div>;
  if (!q.data || 'error' in q.data) return <div className="card card-pad text-danger">Application not found.</div>;

  const t = q.data;
  const a = t.application;
  const e = a.enrichment;
  const fundedAmt = t.decisions.find((d) => d.fundingStatus === 'FUNDED')?.fundingAmount;
  const revTotal = t.revenueEvents.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Application ${a.externalApplicationId}`}
        subtitle={
          <>
            Partner <Link href={`/partners/${t.partner.id}`} className="text-accent hover:underline">{t.partner.name}</Link>
          </>
        }
        action={<StatusPill>{a.status}</StatusPill>}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Status" value={a.status} hint={a.submittedAt ? `submitted ${formatDateTime(a.submittedAt)}` : 'created ' + formatDateTime(a.createdAt)} />
        <KpiCard label="Decisions" value={t.decisions.length.toString()} hint={`${t.decisions.filter((d) => d.decision === 'APPROVED').length} approved`} />
        <KpiCard label="Funded amount" value={fundedAmt ? formatMoney(fundedAmt) : '—'} hint={fundedAmt ? 'closed' : 'not yet funded'} />
        <KpiCard label="EazePay revenue" value={formatMoney(revTotal)} hint={`${t.revenueEvents.length} ledger events`} />
      </div>

      {/* Enrichment */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SectionCard title="Pre-qual enrichment" subtitle="from Pixie · stored at submission" className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4">
            <Field label="Credit score" value={e.creditScore?.toString() ?? '—'} mono tone={creditTone(e.creditScore)} />
            <Field label="Available credit" value={e.availableCredit ? formatMoney(e.availableCredit) : '—'} mono />
            <Field label="Annual income (noted)" value={e.notedAnnualIncome ? formatMoney(e.notedAnnualIncome) : '—'} mono />
            <Field label="Bank statements" value={e.bankStatementsProvided ? 'Provided' : 'Not provided'} pill={e.bankStatementsProvided ? 'success' : 'muted'} />
            <Field label="Open credit lines" value={e.openLinesOfCredit?.toString() ?? '—'} mono />
            <Field label="Propensity score" value={e.propensityScore ? Number(e.propensityScore).toFixed(2) : '—'} mono />
            <Field label="Funding estimate" value={e.fundingEstimate ? formatMoney(e.fundingEstimate) : '—'} mono />
            <Field label="Merchant pre-approval" value={e.merchantPreapproval ? 'Yes' : 'No'} pill={e.merchantPreapproval ? 'success' : 'muted'} hint={e.merchantPreapprovalAmount ? formatMoney(e.merchantPreapprovalAmount) : undefined} />
            <Field label="Consumer pre-approval" value={e.consumerPreapproval ? 'Yes' : 'No'} pill={e.consumerPreapproval ? 'success' : 'muted'} hint={e.consumerPreapprovalAmount ? formatMoney(e.consumerPreapprovalAmount) : undefined} />
          </div>
        </SectionCard>

        <SectionCard title="Consumer (PII)" subtitle="encrypted at rest · masked by default" action={!pii && <button disabled={piiBusy} onClick={revealPii} className="text-xs text-accent hover:underline">{piiBusy ? '…' : 'Reveal'}</button>}>
          <div className="space-y-3 text-sm">
            <Field label="Name" value={pii?.consumerName ?? '·······'} masked={!pii} />
            <Field label="Email" value={pii?.consumerEmail ?? '·······@·······'} masked={!pii} />
            <Field label="Phone" value={pii?.consumerPhone ?? '·······'} masked={!pii} mono />
            {piiError && <div className="text-xs text-danger">{piiError}</div>}
            {pii && <div className="text-[11px] text-muted bg-warnSoft text-warn p-2 rounded">PII access logged to audit trail · operator action recorded</div>}
          </div>
        </SectionCard>
      </div>

      {/* Decision timeline */}
      <SectionCard title="Lender decision waterfall" subtitle={`${t.decisions.length} decision${t.decisions.length === 1 ? '' : 's'}`} bodyClassName="p-0">
        {t.decisions.length === 0 ? (
          <div className="text-muted text-sm px-5 py-6">No decisions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Lender</th>
                  <th>Tier</th>
                  <th>Decision</th>
                  <th className="text-right">Approved $</th>
                  <th className="text-right">APR</th>
                  <th className="text-right">Term</th>
                  <th className="text-right">Monthly</th>
                  <th className="text-right">Origination</th>
                  <th>Funding</th>
                  <th className="text-right">Funded $</th>
                </tr>
              </thead>
              <tbody>
                {t.decisions.map((d) => (
                  <tr key={d.id}>
                    <td className="numeric text-muted whitespace-nowrap">{formatDateTime(d.decisionTimestamp)}</td>
                    <td className="font-medium text-ink">
                      <Link href={`/lenders/${encodeURIComponent(d.lenderName)}`} className="hover:text-accent">{d.lenderName}</Link>
                    </td>
                    <td><StatusPill>{d.lenderTier}</StatusPill></td>
                    <td><StatusPill>{d.decision}</StatusPill></td>
                    <td className="numeric text-right text-ink">{d.approvalAmount ? formatMoney(d.approvalAmount) : '—'}</td>
                    <td className="numeric text-right text-ink2">{d.apr ? `${Number(d.apr).toFixed(2)}%` : '—'}</td>
                    <td className="numeric text-right text-ink2">{d.term ? `${d.term} mo` : '—'}</td>
                    <td className="numeric text-right text-ink2">{d.monthlyPayment ? formatMoney(d.monthlyPayment) : '—'}</td>
                    <td className="numeric text-right text-ink2">{d.originationFee ? formatMoney(d.originationFee) : '—'}</td>
                    <td><StatusPill>{d.fundingStatus}</StatusPill></td>
                    <td className="numeric text-right text-success font-medium">{d.fundingAmount ? formatMoney(d.fundingAmount) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Revenue events tied */}
      <SectionCard title="Revenue events" subtitle={`${t.revenueEvents.length} ledger entries · ${formatMoney(revTotal)} net`} bodyClassName="p-0">
        {t.revenueEvents.length === 0 ? (
          <div className="text-muted text-sm px-5 py-6">No revenue booked.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Effective</th>
                  <th>Stream</th>
                  <th>Type</th>
                  <th>Idempotency key</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {t.revenueEvents.map((r) => {
                  const negative = Number(r.amount) < 0;
                  return (
                    <tr key={r.idempotencyKey}>
                      <td className="numeric text-muted whitespace-nowrap">{formatDateTime(r.effectiveAt)}</td>
                      <td><StatusPill>{r.stream}</StatusPill></td>
                      <td><StatusPill>{r.eventType}</StatusPill></td>
                      <td className="text-[11px] text-muted truncate max-w-[300px]"><code>{r.idempotencyKey}</code></td>
                      <td className={`numeric text-right font-medium ${negative ? 'text-danger' : 'text-success'}`}>
                        {negative ? '−' : ''}{formatMoney(Math.abs(Number(r.amount)))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function Field({ label, value, mono, hint, pill, masked, tone }: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
  pill?: 'success' | 'muted' | 'warn' | 'danger';
  masked?: boolean;
  tone?: 'success' | 'warn' | 'danger';
}): JSX.Element {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      {pill ? (
        <div className="mt-1"><span className={`pill pill-${pill}`}>{value}</span></div>
      ) : (
        <div className={`${mono ? 'numeric' : ''} text-sm font-medium mt-0.5 ${masked ? 'text-muted tracking-widest' : toneClass}`}>{value}</div>
      )}
      {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function creditTone(score: number | null): 'success' | 'warn' | 'danger' | undefined {
  if (score == null) return undefined;
  if (score >= 720) return 'success';
  if (score >= 640) return 'warn';
  return 'danger';
}
