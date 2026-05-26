'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
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
import { FilterBar, type FilterDef } from '@/components/ui/FilterBar';
import { listOptions } from '@/lib/taxonomy';

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

const FILTERS: FilterDef[] = [
  {
    key: 'risk-band',
    label: 'Risk',
    type: 'select',
    options: listOptions('riskBand'),
  },
  {
    key: 'funded',
    label: 'Funded?',
    type: 'select',
    options: [
      { value: 'true', label: 'Funded' },
      { value: 'false', label: 'Not funded' },
    ],
  },
];

export default function CustomerBook(): JSX.Element {
  const params = useSearchParams();
  const riskBand = params.get('risk-band') ?? '';
  const hasFunded = params.get('funded') ?? '';

  const q = useQuery({
    queryKey: ['customers.book', riskBand, hasFunded],
    queryFn: () => {
      const qp = new URLSearchParams();
      if (riskBand) qp.set('riskBand', riskBand);
      if (hasFunded) qp.set('hasFunded', hasFunded);
      qp.set('limit', '200');
      return api<CustomerRow[]>(`/customers?${qp.toString()}`);
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
        action={<FilterBar filters={FILTERS} />}
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
                    <StatusPill domain="application">{c.latestStatus}</StatusPill>
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
            </StaggerList>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
