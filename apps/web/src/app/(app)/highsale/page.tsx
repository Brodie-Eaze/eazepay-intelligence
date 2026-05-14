'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';
import { StatusPill } from '@/components/StatusPill';

/**
 * /highsale — credit-data snapshot drill page.
 *
 * One row per HighSale (EZ Check) pull. The team's questions:
 *   - Who's in our funnel right now and on what credit profile?
 *   - What's our BNPL approval rate vs. consumer-loan approval rate?
 *   - Why are applicants getting DQ'd? (top reasons)
 *   - Is HighSale's ML confidence calibrated to actual outcomes?
 *
 * Filters: vertical, BNPL-qualified, score band. Click a row to drill
 * into the underlying customer record.
 */

interface SnapshotRow {
  id: string;
  vertical: 'medpay' | 'tradepay' | 'coachpay';
  pulledAt: string;
  highsaleTransactionId: string;
  externalApplicationId: string | null;
  applicationId: string | null;
  consumerEmailHash: string;
  score: number;
  averageGrade: number;
  isQualified: boolean;
  isQualifiedBnpl: boolean;
  isQualifiedConsumerLoan: boolean;
  dqReasons: string[];
  confidenceScoreBnpl: string;
  fundingEstimateBnplCents: number;
  availableCreditCents: number;
  utilization: string;
  numOfChargeOffs: number;
  numOfRepos: number;
  numOfForeclosures: number;
  saleConfidenceScore: string;
}

interface Aggregates {
  total: number;
  last24h: number;
  avgScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  avgMlConfidence: string | null;
  byVertical: Array<{ vertical: string; count: number; avgScore: number | null }>;
  byQualification: { bnplQualified: number; bnplNotQualified: number };
  topDqReasons: Array<{ reason: string; count: number }>;
}

interface SnapshotsResp {
  data: SnapshotRow[];
  aggregates: Aggregates;
}

type VerticalFilter = '' | 'medpay' | 'tradepay' | 'coachpay';
type BnplFilter = '' | 'true' | 'false';

export default function HighSalePage(): JSX.Element {
  const [vertical, setVertical] = useState<VerticalFilter>('');
  const [bnpl, setBnpl] = useState<BnplFilter>('');
  const [scoreBand, setScoreBand] = useState<'' | 'prime' | 'near' | 'sub' | 'deep'>('');

  const params = new URLSearchParams();
  if (vertical) params.set('vertical', vertical);
  if (bnpl) params.set('isQualifiedBnpl', bnpl);
  if (scoreBand === 'prime') params.set('scoreMin', '720');
  if (scoreBand === 'near') {
    params.set('scoreMin', '660');
    params.set('scoreMax', '719');
  }
  if (scoreBand === 'sub') {
    params.set('scoreMin', '580');
    params.set('scoreMax', '659');
  }
  if (scoreBand === 'deep') params.set('scoreMax', '579');
  params.set('limit', '200');

  const q = useQuery({
    queryKey: ['highsale.snapshots', vertical, bnpl, scoreBand],
    queryFn: () => api<SnapshotsResp>(`/highsale/snapshots?${params.toString()}`),
  });

  const rows = q.data?.data ?? [];
  const agg = q.data?.aggregates;

  const bnplRate = agg
    ? agg.byQualification.bnplQualified + agg.byQualification.bnplNotQualified > 0
      ? agg.byQualification.bnplQualified /
        (agg.byQualification.bnplQualified + agg.byQualification.bnplNotQualified)
      : null
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="HighSale (EZ Check)"
        subtitle="Per-application credit-data snapshots · ~70 fields per applicant · PII encrypted at rest"
        action={
          <Link
            href="/highsale/schema"
            className="text-xs px-3 py-1.5 rounded-md border border-line2 text-ink2 hover:bg-paper hover:border-accent transition"
          >
            Schema reference →
          </Link>
        }
      />

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard
          label="Snapshots (total)"
          value={agg ? formatNumber(agg.total) : '…'}
          hint={agg ? `${formatNumber(agg.last24h)} last 24h` : '—'}
        />
        <KpiCard
          label="Avg score"
          value={agg?.avgScore != null ? Math.round(agg.avgScore).toString() : '—'}
          hint={
            agg?.minScore != null && agg?.maxScore != null
              ? `range ${agg.minScore}–${agg.maxScore}`
              : '—'
          }
        />
        <KpiCard
          label="BNPL qualified rate"
          value={bnplRate != null ? formatPct(bnplRate) : '—'}
          hint={
            agg
              ? `${formatNumber(agg.byQualification.bnplQualified)} / ${formatNumber(
                  agg.byQualification.bnplQualified + agg.byQualification.bnplNotQualified,
                )}`
              : '—'
          }
        />
        <KpiCard
          label="HighSale ML confidence"
          value={
            agg?.avgMlConfidence != null
              ? `${(Number(agg.avgMlConfidence) * 100).toFixed(1)}%`
              : '—'
          }
          hint="avg across snapshots"
        />
        <KpiCard label="Filtered" value={formatNumber(rows.length)} hint="rows below" />
      </div>

      {/* ── By-vertical breakdown ─────────────────────────────────────── */}
      {agg && agg.byVertical.length > 0 && (
        <SectionCard
          title="By vertical"
          subtitle="snapshot count + avg credit score per BNPL brand"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-3">
            {agg.byVertical.map((v) => {
              const maxCount = Math.max(...agg.byVertical.map((x) => x.count));
              return (
                <div key={v.vertical}>
                  <div className="flex items-center justify-between mb-1.5 text-sm">
                    <span className="text-ink font-medium capitalize">{v.vertical}</span>
                    <span className="numeric text-ink2">
                      {formatNumber(v.count)}
                      <span className="text-muted text-xs ml-2">
                        avg {v.avgScore != null ? Math.round(v.avgScore) : '—'}
                      </span>
                    </span>
                  </div>
                  <MiniBar value={maxCount ? v.count / maxCount : 0} className="h-2.5" />
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* ── Top DQ reasons (filtered set) ─────────────────────────────── */}
      {agg && agg.topDqReasons.length > 0 && (
        <SectionCard
          title="Top decline reasons"
          subtitle={`across the ${rows.length} filtered snapshot${rows.length === 1 ? '' : 's'}`}
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th className="text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {agg.topDqReasons.map((r) => (
                  <tr key={r.reason}>
                    <td className="text-ink2">{r.reason}</td>
                    <td className="numeric text-right text-ink">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <SectionCard
        title="Snapshots"
        subtitle="filter + drill · most recent first"
        bodyClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-line2 text-xs">
          <FilterGroup label="Vertical">
            <FilterButton active={vertical === ''} onClick={() => setVertical('')}>
              All
            </FilterButton>
            <FilterButton active={vertical === 'medpay'} onClick={() => setVertical('medpay')}>
              MedPay
            </FilterButton>
            <FilterButton active={vertical === 'tradepay'} onClick={() => setVertical('tradepay')}>
              TradePay
            </FilterButton>
            <FilterButton active={vertical === 'coachpay'} onClick={() => setVertical('coachpay')}>
              CoachPay
            </FilterButton>
          </FilterGroup>

          <FilterGroup label="BNPL qualified">
            <FilterButton active={bnpl === ''} onClick={() => setBnpl('')}>
              Any
            </FilterButton>
            <FilterButton active={bnpl === 'true'} onClick={() => setBnpl('true')}>
              Yes
            </FilterButton>
            <FilterButton active={bnpl === 'false'} onClick={() => setBnpl('false')}>
              No
            </FilterButton>
          </FilterGroup>

          <FilterGroup label="Score band">
            <FilterButton active={scoreBand === ''} onClick={() => setScoreBand('')}>
              Any
            </FilterButton>
            <FilterButton active={scoreBand === 'prime'} onClick={() => setScoreBand('prime')}>
              Prime ≥720
            </FilterButton>
            <FilterButton active={scoreBand === 'near'} onClick={() => setScoreBand('near')}>
              Near 660–719
            </FilterButton>
            <FilterButton active={scoreBand === 'sub'} onClick={() => setScoreBand('sub')}>
              Sub 580–659
            </FilterButton>
            <FilterButton active={scoreBand === 'deep'} onClick={() => setScoreBand('deep')}>
              Deep &lt;580
            </FilterButton>
          </FilterGroup>
        </div>

        {/* ── Snapshot table ─────────────────────────────────────────── */}
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Pulled</th>
                <th>Vertical</th>
                <th className="text-right">Score</th>
                <th>BNPL</th>
                <th className="text-right">BNPL fund est.</th>
                <th className="text-right">Available credit</th>
                <th className="text-right">Util</th>
                <th>Adverse</th>
                <th className="text-right">ML conf</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const adverse = r.numOfChargeOffs + r.numOfRepos + r.numOfForeclosures;
                return (
                  <tr key={r.id}>
                    <td className="numeric text-muted whitespace-nowrap">
                      {formatDateTime(r.pulledAt)}
                    </td>
                    <td>
                      <span className="tag capitalize">{r.vertical}</span>
                    </td>
                    <td className="numeric text-right font-medium text-ink">
                      {r.score}
                      <span className="text-muted text-xs ml-1">/{r.averageGrade}</span>
                    </td>
                    <td>
                      <StatusPill>{r.isQualifiedBnpl ? 'APPROVED' : 'DECLINED'}</StatusPill>
                      <span className="text-[10px] text-muted ml-1 numeric">
                        {(Number(r.confidenceScoreBnpl) * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="numeric text-right text-ink2">
                      {formatMoney(r.fundingEstimateBnplCents / 100)}
                    </td>
                    <td className="numeric text-right text-ink2">
                      {formatMoney(r.availableCreditCents / 100)}
                    </td>
                    <td className="numeric text-right text-ink2">
                      {(Number(r.utilization) * 100).toFixed(0)}%
                    </td>
                    <td>
                      {adverse > 0 ? (
                        <span className="text-danger text-xs">
                          {r.numOfChargeOffs > 0 && `${r.numOfChargeOffs}co `}
                          {r.numOfRepos > 0 && `${r.numOfRepos}repo `}
                          {r.numOfForeclosures > 0 && `${r.numOfForeclosures}fc`}
                        </span>
                      ) : (
                        <span className="text-soft text-xs">—</span>
                      )}
                    </td>
                    <td className="numeric text-right text-ink2">
                      {(Number(r.saleConfidenceScore) * 100).toFixed(0)}%
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <Link
                        href={`/highsale/${r.id}`}
                        className="text-accent text-xs hover:underline mr-3"
                      >
                        all 70 fields →
                      </Link>
                      <Link
                        href={`/customers/${r.consumerEmailHash}`}
                        className="text-muted text-xs hover:text-ink2 hover:underline"
                      >
                        customer
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="text-muted py-12 text-center text-sm">
                    No HighSale snapshots match these filters yet. POST to{' '}
                    <code className="kbd">/api/v1/integration/highsale/snapshots</code> with a
                    signed payload to seed one.
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

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted text-[11px] uppercase tracking-wider mr-1">{label}</span>
      {children}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md border transition ${
        active ? 'border-accent text-accent bg-accentSoft' : 'border-line text-ink2 hover:bg-paper'
      }`}
    >
      {children}
    </button>
  );
}
