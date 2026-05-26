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
import { StaggerList } from '@/components/motion';
import { EmptyState } from '@/components/EmptyState';

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

  const rows = q.data ?? [];
  const totalFunded = rows.reduce((s, r) => s + Number(r.totalFunded), 0);
  const fundedCount = rows.filter((r) => r.fundings > 0).length;
  const bandCounts = rows.reduce<Record<string, number>>((a, r) => {
    a[r.riskBand] = (a[r.riskBand] ?? 0) + 1;
    return a;
  }, {});
  const primeCount = bandCounts.PRIME ?? 0;

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
        <KpiCard label="Customers" value={formatNumber(rows.length)} hint="distinct individuals" />
        <KpiCard
          label="Funded"
          value={formatNumber(fundedCount)}
          hint={`${rows.length ? ((fundedCount / rows.length) * 100).toFixed(0) : 0}% of book`}
        />
        <KpiCard label="Prime" value={formatNumber(primeCount)} hint="credit ≥ 720" />
        <KpiCard
          label="Total funded"
          value={formatMoney(totalFunded)}
          hint="lifetime across the book"
        />
      </div>

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
            <StaggerList as="tbody" stagger={20} maxAnimated={15}>
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
                  <td colSpan={9} className="p-0">
                    <EmptyState
                      variant="filterEmpty"
                      title="No customers match the filters"
                      description="Try widening the date range or clearing a status filter. The data is there — the lens is just too narrow."
                      inline
                    />
                  </td>
                </tr>
              )}
            </StaggerList>
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
