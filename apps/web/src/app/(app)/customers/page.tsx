'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { RiskBand } from '@/components/RiskBand';
import { Monogram } from '@/components/Monogram';
import { KpiCard } from '@/components/KpiCard';

interface CustomerRow {
  emailHash: string;
  applications: number;
  partnerCount: number;
  fundings: number;
  latestApplicationAt: string;
  latestPartnerId: string;
  latestStatus: string;
  latestCreditScore: number | null;
  latestIncome: string | null;
  latestPropensity: string | null;
  totalFunded: string;
  riskBand: string;
}

const BANDS = ['', 'PRIME', 'NEAR_PRIME', 'SUBPRIME', 'DEEP_SUBPRIME', 'UNSCORED'] as const;
const FUNDED = ['', 'true', 'false'] as const;

export default function CustomerBook(): JSX.Element {
  const [riskBand, setRiskBand] = useState<(typeof BANDS)[number]>('');
  const [hasFunded, setHasFunded] = useState<(typeof FUNDED)[number]>('');

  const q = useQuery({
    queryKey: ['customers.book', riskBand, hasFunded],
    queryFn: () => {
      const params = new URLSearchParams();
      if (riskBand) params.set('riskBand', riskBand);
      if (hasFunded) params.set('hasFunded', hasFunded);
      params.set('limit', '200');
      return api<CustomerRow[]>(`/customers?${params.toString()}`);
    },
  });

  const stats = useQuery({
    queryKey: ['customers.stats'],
    queryFn: () =>
      api<{
        totalCustomers: number;
        withFunded: number;
        fundedRate: number;
        multiPartner: number;
        multiPartnerRate: number;
        multiApp: number;
        repeatRate: number;
        avgCreditScore: number | null;
        avgIncome: number | null;
        avgPropensity: number | null;
        avgLti: number | null;
        totalFunded: string;
        totalRevenue: string;
        avgRevenuePerCustomer: number;
      } | null>('/customers/stats'),
  });

  const rows = q.data ?? [];
  const totalFunded = rows.reduce((s, r) => s + Number(r.totalFunded), 0);
  const fundedCount = rows.filter((r) => r.fundings > 0).length;
  const bandCounts = rows.reduce<Record<string, number>>((a, r) => {
    a[r.riskBand] = (a[r.riskBand] ?? 0) + 1;
    return a;
  }, {});
  const primeCount = bandCounts.PRIME ?? 0;
  const s = stats.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer book"
        subtitle="Every individual who has flowed through the platform · deduped by encrypted email hash"
        action={
          <div className="flex items-center gap-2">
            <Select
              label="Risk"
              value={riskBand}
              onChange={setRiskBand as (v: string) => void}
              options={BANDS}
            />
            <Select
              label="Funded?"
              value={hasFunded}
              onChange={setHasFunded as (v: string) => void}
              options={FUNDED}
              display={(v) => (v === '' ? 'all' : v === 'true' ? 'Funded' : 'Not funded')}
            />
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="In view" value={formatNumber(rows.length)} hint="filters applied" />
        <KpiCard
          label="Funded (book)"
          value={s ? formatNumber(s.withFunded) : '…'}
          hint={s ? `${(s.fundedRate * 100).toFixed(0)}% of book lifetime` : ''}
        />
        <KpiCard label="Prime" value={formatNumber(primeCount)} hint="credit ≥ 720 in view" />
        <KpiCard
          label="Total funded (lifetime)"
          value={s ? formatMoney(s.totalFunded) : formatMoney(totalFunded)}
          hint={s ? `rev/cust ${formatMoney(s.avgRevenuePerCustomer)}` : ''}
        />
      </div>

      <SectionCard
        title="Book health"
        subtitle="aggregate stats across the entire deduped customer set"
        bodyClassName="p-0"
      >
        {s ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 divide-x divide-line2">
            <Cell
              label="Customers"
              value={formatNumber(s.totalCustomers)}
              hint="distinct identities"
            />
            <Cell
              label="Repeat"
              value={formatNumber(s.multiApp)}
              hint={`${(s.repeatRate * 100).toFixed(0)}% with >1 app`}
            />
            <Cell
              label="Cross-partner"
              value={formatNumber(s.multiPartner)}
              hint={`${(s.multiPartnerRate * 100).toFixed(0)}% touched >1 partner`}
            />
            <Cell
              label="Avg credit"
              value={s.avgCreditScore?.toString() ?? '—'}
              hint="across the book"
            />
            <Cell
              label="Avg income"
              value={s.avgIncome ? formatMoney(Math.round(s.avgIncome)) : '—'}
              hint="noted by consumer"
            />
            <Cell
              label="Avg LTI"
              value={s.avgLti != null ? `${(s.avgLti * 100).toFixed(0)}%` : '—'}
              hint="loan-to-income (funded)"
              tone={
                s.avgLti != null
                  ? s.avgLti < 0.25
                    ? 'success'
                    : s.avgLti < 0.5
                      ? 'warn'
                      : 'danger'
                  : undefined
              }
            />
          </div>
        ) : (
          <div className="text-muted text-sm p-5">…</div>
        )}
      </SectionCard>

      <SectionCard
        title={`${rows.length} customers`}
        subtitle="latest application first · click a row for the full financial profile"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Risk band</th>
                <th className="text-right">Credit</th>
                <th className="text-right">Income</th>
                <th className="text-right">Propensity</th>
                <th className="text-right">Apps</th>
                <th>Latest status</th>
                <th className="text-right">Funded</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.emailHash}>
                  <td>
                    <Link
                      href={`/customers/${c.emailHash}`}
                      className="inline-flex items-center gap-2 text-ink hover:text-accent"
                    >
                      <Monogram label={`# ${c.emailHash.slice(0, 2)}`} />
                      <div>
                        <div className="font-medium tracking-tight">
                          Customer {c.emailHash.slice(0, 8)}
                        </div>
                        <div className="text-[11px] text-muted numeric">
                          {c.partnerCount} partner{c.partnerCount === 1 ? '' : 's'} touched
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td>
                    <RiskBand band={c.riskBand} />
                  </td>
                  <td className="numeric text-right text-ink2">{c.latestCreditScore ?? '—'}</td>
                  <td className="numeric text-right text-ink2">
                    {c.latestIncome ? formatMoney(c.latestIncome) : '—'}
                  </td>
                  <td className="numeric text-right text-ink2">
                    {c.latestPropensity ? `${(Number(c.latestPropensity) * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="numeric text-right text-ink">{c.applications}</td>
                  <td>
                    <StatusPill>{c.latestStatus}</StatusPill>
                  </td>
                  <td className="numeric text-right text-success font-medium">
                    {Number(c.totalFunded) > 0 ? formatMoney(c.totalFunded) : '—'}
                  </td>
                  <td className="numeric text-muted text-xs whitespace-nowrap">
                    {formatDateTime(c.latestApplicationAt)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-muted py-8 text-center">
                    No customers match the filters.
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

function Select({
  label,
  value,
  onChange,
  options,
  display,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  display?: (v: string) => string;
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface border border-line rounded-md px-2.5 py-1.5 text-ink2 outline-none focus:border-accent text-xs"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {display
              ? display(o)
              : o
                ? o
                    .replace(/_/g, ' ')
                    .toLowerCase()
                    .replace(/\b\w/g, (c) => c.toUpperCase())
                : 'all'}
          </option>
        ))}
      </select>
    </label>
  );
}

function Cell({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'warn' | 'danger';
}): JSX.Element {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-ink';
  return (
    <div className="px-5 py-4">
      <div className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">{label}</div>
      <div className={`numeric text-[20px] font-semibold tracking-tight mt-1 ${toneClass}`}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-muted mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}
