'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { RiskBand } from '@/components/RiskBand';
import { Monogram } from '@/components/Monogram';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';

interface CustomerDetail {
  emailHash: string;
  profile: {
    firstSeen: string;
    lastSeen: string;
    applications: number;
    partners: number;
    riskBand: string;
    latestCreditScore: number | null;
    avgCreditScore: number | null;
    creditScoreTrend: Array<{ at: string; score: number | null }>;
    latestIncome: string | null;
    latestPropensity: string | null;
    latestAvailableCredit: string | null;
    latestOpenLines: number | null;
    bankStatementsProvided: boolean;
    merchantPreapprovals: number;
    consumerPreapprovals: number;
  };
  financial: { totalFunded: string; totalRevenue: string; totalFundingEstimate: string };
  applications: Array<{
    id: string;
    externalApplicationId: string;
    createdAt: string;
    status: string;
    partner: { id: string; name: string; externalId: string; industry: string };
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
    decisions: Array<{
      id: string;
      lenderName: string;
      lenderTier: string;
      decision: string;
      decisionTimestamp: string;
      approvalAmount: string | null;
      apr: string | null;
      term: number | null;
      fundingStatus: string;
      fundingAmount: string | null;
    }>;
  }>;
  revenueEvents: Array<{ idempotencyKey: string; stream: string; eventType: string; amount: string; effectiveAt: string }>;
}

interface PiiResp { consumerName: string; consumerEmail: string; consumerPhone: string }

export default function CustomerDetail({ params }: { params: { hash: string } }): JSX.Element {
  const [pii, setPii] = useState<PiiResp | null>(null);
  const [piiBusy, setPiiBusy] = useState(false);
  const [piiErr, setPiiErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['customer.detail', params.hash],
    queryFn: () => api<CustomerDetail>(`/customers/${params.hash}`),
  });

  const reveal = async (): Promise<void> => {
    setPiiBusy(true); setPiiErr(null);
    try {
      const r = await api<PiiResp>(`/customers/${params.hash}/pii`);
      setPii(r);
    } catch (err) { setPiiErr(err instanceof ApiError ? err.message : 'Failed'); }
    finally { setPiiBusy(false); }
  };

  if (q.isLoading) return <div className="text-muted">Loading…</div>;
  if (!q.data) return <div className="card card-pad text-danger">Customer not found.</div>;

  const c = q.data;
  const p = c.profile;
  const tenureDays = Math.floor((Date.now() - new Date(p.firstSeen).getTime()) / 86_400_000);

  // build credit-score trend with non-null entries
  const trend = p.creditScoreTrend.filter((t): t is { at: string; score: number } => t.score != null);

  return (
    <div className="space-y-6">
      <div className="card card-pad">
        <div className="flex items-start gap-5">
          <div className="!h-14 !w-14"><Monogram label={`# ${params.hash.slice(0, 2)}`} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className="text-ink text-2xl font-semibold tracking-tight">
                {pii ? pii.consumerName : `Customer ${params.hash.slice(0, 8)}`}
              </h1>
              <RiskBand band={p.riskBand} />
              {pii ? (
                <span className="text-sm text-muted">{pii.consumerEmail} · {pii.consumerPhone}</span>
              ) : (
                <button onClick={reveal} disabled={piiBusy} className="text-xs text-accent hover:underline disabled:opacity-50">
                  {piiBusy ? '…' : 'Reveal name & contact'}
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-xs text-muted flex-wrap">
              <span>{tenureDays} days in book</span>
              <span className="text-line">·</span>
              <span>{p.applications} application{p.applications === 1 ? '' : 's'}</span>
              <span className="text-line">·</span>
              <span>{p.partners} partner{p.partners === 1 ? '' : 's'}</span>
              <span className="text-line">·</span>
              <span className="numeric">first seen {formatDateTime(p.firstSeen)}</span>
            </div>
            {piiErr && <div className="text-xs text-danger mt-2">{piiErr}</div>}
          </div>
          <Link href="/customers" className="text-xs text-accent hover:underline">← Customer book</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Latest credit score"
          value={p.latestCreditScore?.toString() ?? '—'}
          hint={p.avgCreditScore ? `avg across apps · ${p.avgCreditScore}` : 'unscored'}
        />
        <KpiCard
          label="Noted income"
          value={p.latestIncome ? formatMoney(p.latestIncome) : '—'}
          hint={p.bankStatementsProvided ? 'bank statements verified' : 'unverified'}
        />
        <KpiCard
          label="Propensity"
          value={p.latestPropensity ? `${(Number(p.latestPropensity) * 100).toFixed(0)}%` : '—'}
          hint="HighSale pre-qual score"
        />
        <KpiCard
          label="Total funded"
          value={Number(c.financial.totalFunded) > 0 ? formatMoney(c.financial.totalFunded) : '—'}
          hint={`EazePay rev ${formatMoney(c.financial.totalRevenue)}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SectionCard title="Credit profile" subtitle="latest snapshot · trends across applications" className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-5 mb-5">
            <Field label="Latest score" value={p.latestCreditScore?.toString() ?? '—'} large tone={creditTone(p.latestCreditScore)} />
            <Field label="Available credit" value={p.latestAvailableCredit ? formatMoney(p.latestAvailableCredit) : '—'} large />
            <Field label="Open credit lines" value={p.latestOpenLines?.toString() ?? '—'} large />
            <Field label="Avg score (all apps)" value={p.avgCreditScore?.toString() ?? '—'} />
            <Field label="Bank statements" value={p.bankStatementsProvided ? 'Provided' : 'Not provided'} pill={p.bankStatementsProvided ? 'success' : 'muted'} />
            <Field label="Risk band" value={p.riskBand} pillNode={<RiskBand band={p.riskBand} />} />
          </div>

          {trend.length >= 2 && (
            <>
              <div className="h-section mb-2">Credit score trend</div>
              <div style={{ height: 120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend.map((t) => ({ at: t.at, score: t.score }))}>
                    <XAxis dataKey="at" hide />
                    <YAxis domain={['dataMin - 20', 'dataMax + 20']} stroke="#94A3B8" fontSize={10} width={36} />
                    <Tooltip
                      contentStyle={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(v) => formatDateTime(v as string)}
                      formatter={(v: number) => [v, 'Credit score']}
                    />
                    <Line type="monotone" dataKey="score" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3, fill: '#3B82F6' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard title="Pre-qualification" subtitle="HighSale Pixie output">
          <Field label="Latest propensity" value={p.latestPropensity ? `${(Number(p.latestPropensity) * 100).toFixed(0)}%` : '—'} large hint="probability of pre-approval" />
          <div className="mt-4 space-y-3">
            <Stage label="Merchant pre-approvals" v={p.merchantPreapprovals} max={p.applications} />
            <Stage label="Consumer pre-approvals" v={p.consumerPreapprovals} max={p.applications} />
            <Stage label="Funding estimate (sum)" valueLabel={formatMoney(c.financial.totalFundingEstimate)} v={1} max={1} />
          </div>
        </SectionCard>
      </div>

      <PeAnalytics customer={c} />

      <SectionCard title="Application history" subtitle={`${c.applications.length} application${c.applications.length === 1 ? '' : 's'} · most recent first`} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Partner</th>
                <th>External ID</th>
                <th className="text-right">Credit</th>
                <th className="text-right">Income</th>
                <th className="text-right">Propensity</th>
                <th className="text-right">Funding est.</th>
                <th>Pre-approval</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.applications.map((a) => (
                <tr key={a.id}>
                  <td className="numeric text-muted whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                  <td>
                    <Link href={`/partners/${a.partner.id}`} className="text-ink hover:text-accent">{a.partner.name}</Link>
                    <div className="text-[11px] text-muted">{a.partner.industry}</div>
                  </td>
                  <td><Link href={`/applications/${a.id}`} className="tag hover:bg-accentSoft hover:text-accent">{a.externalApplicationId}</Link></td>
                  <td className="numeric text-right text-ink2">{a.creditScore ?? '—'}</td>
                  <td className="numeric text-right text-ink2">{a.notedAnnualIncome ? formatMoney(a.notedAnnualIncome) : '—'}</td>
                  <td className="numeric text-right text-ink2">{a.propensityScore ? `${(Number(a.propensityScore) * 100).toFixed(0)}%` : '—'}</td>
                  <td className="numeric text-right text-ink2">{a.fundingEstimate ? formatMoney(a.fundingEstimate) : '—'}</td>
                  <td className="text-xs text-muted">
                    {a.merchantPreapproval && <span className="pill pill-info mr-1">Merchant</span>}
                    {a.consumerPreapproval && <span className="pill pill-info">Consumer</span>}
                    {!a.merchantPreapproval && !a.consumerPreapproval && '—'}
                  </td>
                  <td><StatusPill>{a.status}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Decision waterfall" subtitle="every lender that saw this customer · across all applications" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Application</th>
                <th>Lender</th>
                <th>Tier</th>
                <th>Decision</th>
                <th className="text-right">Approved $</th>
                <th className="text-right">APR</th>
                <th className="text-right">Term</th>
                <th>Funding</th>
                <th className="text-right">Funded $</th>
              </tr>
            </thead>
            <tbody>
              {c.applications.flatMap((a) => a.decisions.map((d) => ({ ...d, ext: a.externalApplicationId, appId: a.id })))
                .sort((a, b) => b.decisionTimestamp.localeCompare(a.decisionTimestamp))
                .map((d) => (
                  <tr key={d.id}>
                    <td className="numeric text-muted whitespace-nowrap">{formatDateTime(d.decisionTimestamp)}</td>
                    <td><Link href={`/applications/${d.appId}`} className="tag">{d.ext}</Link></td>
                    <td className="text-ink font-medium"><Link href={`/lenders/${encodeURIComponent(d.lenderName)}`} className="hover:text-accent">{d.lenderName}</Link></td>
                    <td><StatusPill>{d.lenderTier}</StatusPill></td>
                    <td><StatusPill>{d.decision}</StatusPill></td>
                    <td className="numeric text-right text-ink">{d.approvalAmount ? formatMoney(d.approvalAmount) : '—'}</td>
                    <td className="numeric text-right text-ink2">{d.apr ? `${Number(d.apr).toFixed(2)}%` : '—'}</td>
                    <td className="numeric text-right text-ink2">{d.term ? `${d.term} mo` : '—'}</td>
                    <td><StatusPill>{d.fundingStatus}</StatusPill></td>
                    <td className="numeric text-right text-success font-medium">{d.fundingAmount ? formatMoney(d.fundingAmount) : '—'}</td>
                  </tr>
                ))}
              {c.applications.flatMap((a) => a.decisions).length === 0 && (
                <tr><td colSpan={10} className="text-center text-muted py-8">No decisions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {c.revenueEvents.length > 0 && (
        <SectionCard title="EazePay revenue from this customer" subtitle={`${c.revenueEvents.length} ledger entries · ${formatMoney(c.financial.totalRevenue)} net`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr><th>Effective</th><th>Stream</th><th>Type</th><th>Idempotency key</th><th className="text-right">Amount</th></tr>
              </thead>
              <tbody>
                {c.revenueEvents.map((r) => {
                  const negative = Number(r.amount) < 0;
                  return (
                    <tr key={r.idempotencyKey}>
                      <td className="numeric text-muted whitespace-nowrap">{formatDateTime(r.effectiveAt)}</td>
                      <td><StatusPill>{r.stream}</StatusPill></td>
                      <td><StatusPill>{r.eventType}</StatusPill></td>
                      <td className="text-[11px] text-muted truncate max-w-[300px]"><span className="tag">{r.idempotencyKey}</span></td>
                      <td className={`numeric text-right font-medium ${negative ? 'text-danger' : 'text-success'}`}>
                        {negative ? '−' : ''}{formatMoney(Math.abs(Number(r.amount)))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function Field({ label, value, large, hint, pill, pillNode, tone }: {
  label: string;
  value: string;
  large?: boolean;
  hint?: string;
  pill?: 'success' | 'muted' | 'warn' | 'danger';
  pillNode?: React.ReactNode;
  tone?: 'success' | 'warn' | 'danger';
}): JSX.Element {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div>
      <div className="h-section">{label}</div>
      {pillNode ? (
        <div className="mt-1.5">{pillNode}</div>
      ) : pill ? (
        <div className="mt-1.5"><span className={`pill pill-${pill}`}>{value}</span></div>
      ) : (
        <div className={`numeric ${large ? 'text-2xl font-semibold' : 'text-sm font-medium'} mt-1 ${toneClass}`}>{value}</div>
      )}
      {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function Stage({ label, v, max, valueLabel }: { label: string; v: number; max: number; valueLabel?: string }): JSX.Element {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="numeric text-ink font-medium">{valueLabel ?? `${v} / ${max}`}</span>
      </div>
      <MiniBar value={max ? v / max : 0} className="mt-1.5" />
    </div>
  );
}

function creditTone(score: number | null): 'success' | 'warn' | 'danger' | undefined {
  if (score == null) return undefined;
  if (score >= 720) return 'success';
  if (score >= 580) return 'warn';
  return 'danger';
}

// ─── PE-grade analytics block ────────────────────────────────────────────
// Everything below is computed on the client from data we already return.

function PeAnalytics({ customer }: { customer: CustomerDetail }): JSX.Element {
  const m = computeMetrics(customer);

  return (
    <>
      {/* Unit economics */}
      <SectionCard
        title="Unit economics"
        subtitle="EazePay's contribution from this customer · gross / net / take rate"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-line2 border-t border-line2">
          <Cell label="Gross revenue"  value={formatMoney(m.grossRevenue)} hint="all positive events" />
          <Cell label="Clawback exposure" value={m.clawbacks > 0 ? `−${formatMoney(m.clawbacks)}` : '—'} hint={`${m.clawbackEvents} event${m.clawbackEvents === 1 ? '' : 's'}`} />
          <Cell label="Net revenue"    value={formatMoney(m.netRevenue)}   hint="after clawbacks" tone={m.netRevenue >= 0 ? undefined : 'danger'} />
          <Cell label="Take rate"      value={m.takeRatePct != null ? `${m.takeRatePct.toFixed(2)}%` : '—'} hint="net rev ÷ funded" />
          <Cell label="Avg ticket"     value={m.avgTicket != null ? formatMoney(m.avgTicket) : '—'} hint={`${m.fundingsCount} funded loan${m.fundingsCount === 1 ? '' : 's'}`} />
        </div>
      </SectionCard>

      {/* Risk & affordability */}
      <SectionCard
        title="Risk & affordability"
        subtitle="leverage, debt service capacity, headroom"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-line2 border-t border-line2">
          <Cell
            label="Loan-to-income"
            value={m.lti != null ? `${(m.lti * 100).toFixed(1)}%` : '—'}
            hint={m.lti != null ? (m.lti < 0.25 ? 'comfortable' : m.lti < 0.5 ? 'moderate' : 'stretched') : 'income n/a'}
            tone={m.lti != null ? (m.lti < 0.25 ? 'success' : m.lti < 0.5 ? 'warn' : 'danger') : undefined}
          />
          <Cell
            label="Funding ÷ available credit"
            value={m.fundingVsAvailable != null ? `${(m.fundingVsAvailable * 100).toFixed(0)}%` : '—'}
            hint="utilization proxy"
          />
          <Cell
            label="APR (weighted)"
            value={m.weightedApr != null ? `${m.weightedApr.toFixed(2)}%` : '—'}
            hint="weighted by funded amount"
          />
          <Cell
            label="Avg term"
            value={m.avgTerm != null ? `${m.avgTerm.toFixed(0)} mo` : '—'}
            hint={`${m.fundingsCount} funded`}
          />
          <Cell
            label="Decline rate"
            value={m.declineRate != null ? `${(m.declineRate * 100).toFixed(0)}%` : '—'}
            hint={`${m.declines} of ${m.decisions} decisions`}
            tone={m.declineRate != null ? (m.declineRate < 0.3 ? 'success' : m.declineRate < 0.6 ? 'warn' : 'danger') : undefined}
          />
        </div>
      </SectionCard>

      {/* Lifecycle */}
      <SectionCard
        title="Lifecycle & behavior"
        subtitle="tenure, velocity, stickiness"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-line2 border-t border-line2">
          <Cell label="Tenure"           value={`${m.tenureDays} d`} hint={`first seen ${new Date(m.firstSeen).toLocaleDateString('en-AU')}`} />
          <Cell label="Days since last"  value={`${m.daysSinceLast} d`} hint="last application" tone={m.daysSinceLast > 90 ? 'warn' : undefined} />
          <Cell label="App velocity"     value={m.appsPerMonth != null ? `${m.appsPerMonth.toFixed(2)}/mo` : '—'} hint="per month on platform" />
          <Cell label="Time to first $"  value={m.timeToFirstFundingDays != null ? `${m.timeToFirstFundingDays} d` : '—'} hint="submission → funding" />
          <Cell label="Touched"          value={`${m.partnerCount} partner${m.partnerCount === 1 ? '' : 's'}`} hint={m.partnerCount > 1 ? 'cross-channel' : 'single channel'} />
        </div>
      </SectionCard>

      {/* Underwriting calibration */}
      <SectionCard
        title="Underwriting calibration"
        subtitle="did Pixie's pre-qual line up with what BuzzPay actually did?"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-line2 border-t border-line2">
          <Cell
            label="Pixie predicted"
            value={m.predictedApproval != null ? `${(m.predictedApproval * 100).toFixed(0)}%` : '—'}
            hint="latest propensity"
          />
          <Cell
            label="Actual approval"
            value={m.actualApproval != null ? `${(m.actualApproval * 100).toFixed(0)}%` : '—'}
            hint={`${m.approvals} of ${m.decisions}`}
          />
          <Cell
            label="Calibration delta"
            value={m.calibrationDelta != null ? `${m.calibrationDelta > 0 ? '+' : ''}${(m.calibrationDelta * 100).toFixed(0)}%` : '—'}
            hint={m.calibrationDelta != null ? (Math.abs(m.calibrationDelta) < 0.1 ? 'well-calibrated' : m.calibrationDelta > 0 ? 'under-scored' : 'over-scored') : ''}
            tone={m.calibrationDelta != null ? (Math.abs(m.calibrationDelta) < 0.1 ? 'success' : 'warn') : undefined}
          />
          <Cell
            label="Funded vs approved"
            value={m.fundingConversion != null ? `${(m.fundingConversion * 100).toFixed(0)}%` : '—'}
            hint="conversion through to funding"
          />
        </div>
      </SectionCard>
    </>
  );
}

function Cell({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'success' | 'warn' | 'danger' }): JSX.Element {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div className="px-5 py-4">
      <div className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">{label}</div>
      <div className={`numeric text-[20px] font-semibold tracking-tight mt-1 ${toneClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}

function computeMetrics(c: CustomerDetail): {
  grossRevenue: number;
  clawbacks: number;
  clawbackEvents: number;
  netRevenue: number;
  takeRatePct: number | null;
  avgTicket: number | null;
  fundingsCount: number;
  lti: number | null;
  fundingVsAvailable: number | null;
  weightedApr: number | null;
  avgTerm: number | null;
  declineRate: number | null;
  declines: number;
  decisions: number;
  approvals: number;
  tenureDays: number;
  daysSinceLast: number;
  firstSeen: string;
  appsPerMonth: number | null;
  timeToFirstFundingDays: number | null;
  partnerCount: number;
  predictedApproval: number | null;
  actualApproval: number | null;
  calibrationDelta: number | null;
  fundingConversion: number | null;
} {
  const events = c.revenueEvents;
  const grossRevenue = events.filter((e) => Number(e.amount) > 0).reduce((s, e) => s + Number(e.amount), 0);
  const clawbacks = Math.abs(events.filter((e) => Number(e.amount) < 0).reduce((s, e) => s + Number(e.amount), 0));
  const clawbackEvents = events.filter((e) => Number(e.amount) < 0).length;
  const netRevenue = grossRevenue - clawbacks;
  const totalFunded = Number(c.financial.totalFunded);
  const takeRatePct = totalFunded > 0 ? (netRevenue / totalFunded) * 100 : null;

  const allDecisions = c.applications.flatMap((a) => a.decisions);
  const fundedDecisions = allDecisions.filter((d) => d.fundingStatus === 'FUNDED' && d.fundingAmount);
  const fundingsCount = fundedDecisions.length;
  const avgTicket = fundingsCount > 0
    ? fundedDecisions.reduce((s, d) => s + Number(d.fundingAmount!), 0) / fundingsCount
    : null;

  const income = c.profile.latestIncome ? Number(c.profile.latestIncome) : null;
  const lti = income && income > 0 ? totalFunded / income : null;

  const availableCredit = c.profile.latestAvailableCredit ? Number(c.profile.latestAvailableCredit) : null;
  const fundingVsAvailable = availableCredit && availableCredit > 0 ? totalFunded / availableCredit : null;

  // weighted APR by funded amount
  const weighted = fundedDecisions
    .filter((d) => d.apr != null && d.fundingAmount != null)
    .reduce((acc, d) => {
      const amt = Number(d.fundingAmount);
      acc.num += Number(d.apr) * amt;
      acc.den += amt;
      return acc;
    }, { num: 0, den: 0 });
  const weightedApr = weighted.den > 0 ? weighted.num / weighted.den : null;

  const terms = fundedDecisions.map((d) => d.term).filter((t): t is number => t != null);
  const avgTerm = terms.length > 0 ? terms.reduce((s, t) => s + t, 0) / terms.length : null;

  const decisionsCount = allDecisions.length;
  const approvals = allDecisions.filter((d) => d.decision === 'APPROVED').length;
  const declines = allDecisions.filter((d) => d.decision === 'DECLINED').length;
  const declineRate = decisionsCount > 0 ? declines / decisionsCount : null;
  const actualApproval = decisionsCount > 0 ? approvals / decisionsCount : null;

  const firstSeen = c.profile.firstSeen;
  const tenureDays = Math.max(0, Math.floor((Date.now() - new Date(firstSeen).getTime()) / 86_400_000));
  const daysSinceLast = Math.max(0, Math.floor((Date.now() - new Date(c.profile.lastSeen).getTime()) / 86_400_000));
  const appsPerMonth = tenureDays > 0 ? (c.profile.applications / tenureDays) * 30 : null;

  // time to first funding: earliest funded decision timestamp - first application createdAt
  const sortedApps = [...c.applications].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const firstApp = sortedApps[0];
  const earliestFunding = c.applications
    .flatMap((a) => a.decisions)
    .filter((d) => d.fundingStatus === 'FUNDED')
    .map((d) => d.decisionTimestamp)
    .sort()[0];
  const timeToFirstFundingDays = firstApp && earliestFunding
    ? Math.max(0, Math.floor((new Date(earliestFunding).getTime() - new Date(firstApp.createdAt).getTime()) / 86_400_000))
    : null;

  const predictedApproval = c.profile.latestPropensity ? Number(c.profile.latestPropensity) : null;
  const calibrationDelta = predictedApproval != null && actualApproval != null
    ? actualApproval - predictedApproval
    : null;

  const fundingConversion = approvals > 0 ? fundingsCount / approvals : null;

  return {
    grossRevenue,
    clawbacks,
    clawbackEvents,
    netRevenue,
    takeRatePct,
    avgTicket,
    fundingsCount,
    lti,
    fundingVsAvailable,
    weightedApr,
    avgTerm,
    declineRate,
    declines,
    decisions: decisionsCount,
    approvals,
    tenureDays,
    daysSinceLast,
    firstSeen,
    appsPerMonth,
    timeToFirstFundingDays,
    partnerCount: c.profile.partners,
    predictedApproval,
    actualApproval,
    calibrationDelta,
    fundingConversion,
  };
}
