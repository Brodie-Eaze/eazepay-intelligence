'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { StatusPill } from '@/components/StatusPill';
import { Monogram } from '@/components/Monogram';

interface Business {
  slug: string;
  name: string;
  vertical: string;
  status: string;
  acquiredAt: string;
  ownershipPct: number;
  hqRegion: string;
  segment: string;
  fteCount: number;
  ttmRevenue: number;
  ttmEbitda: number;
  ttmGrossProfit: number;
  arr: number;
  nrr: number;
  grossMargin: number;
  cashOnHand: number;
  netDebt: number;
}

interface VerticalDetail {
  vertical: { slug: string; name: string; description: string };
  rollup: {
    businessCount: number;
    activeCount: number;
    ttmRevenue: number;
    ttmEbitda: number;
    ttmGrossProfit: number;
    fteCount: number;
    cashOnHand: number;
    netDebt: number;
  };
  businesses: Business[];
}

export default function VerticalDetail(): JSX.Element {
  const params = useParams<{ vertical: string }>();
  const slug = params.vertical;

  const q = useQuery({
    queryKey: ['portfolio.vertical', slug],
    queryFn: () => api<VerticalDetail>(`/portfolio/verticals/${slug}`),
    enabled: Boolean(slug),
  });

  const data = q.data;
  const r = data?.rollup;
  const businesses = data?.businesses ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Link href="/portfolio" className="hover:text-ink">
          Portfolio
        </Link>
        <ChevronRight size={12} />
        <span className="text-ink">{data?.vertical.name ?? slug}</span>
      </div>
      <PageHeader
        title={data?.vertical.name ?? '…'}
        subtitle={data?.vertical.description ?? 'Loading vertical…'}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="TTM revenue"
          value={r ? formatMoney(r.ttmRevenue) : '…'}
          hint={r ? `${formatNumber(r.activeCount)} of ${r.businessCount} active` : ''}
        />
        <KpiCard
          label="TTM EBITDA"
          value={r ? formatMoney(r.ttmEbitda) : '…'}
          hint={r ? `${formatPct(r.ttmRevenue ? r.ttmEbitda / r.ttmRevenue : 0)} margin` : ''}
        />
        <KpiCard
          label="TTM gross profit"
          value={r ? formatMoney(r.ttmGrossProfit) : '…'}
          hint={r ? formatPct(r.ttmRevenue ? r.ttmGrossProfit / r.ttmRevenue : 0) + ' GM' : ''}
        />
        <KpiCard
          label="Headcount"
          value={r ? formatNumber(r.fteCount) : '…'}
          hint={
            r && r.netDebt < 0
              ? `${formatMoney(Math.abs(r.netDebt))} net cash`
              : r
                ? `${formatMoney(r.netDebt)} net debt`
                : ''
          }
        />
      </div>

      <SectionCard
        title="Businesses in this vertical"
        subtitle="click a row for the full business deep-dive"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Business</th>
                <th>Status</th>
                <th>Segment</th>
                <th className="text-right">Ownership</th>
                <th className="text-right">TTM revenue</th>
                <th className="text-right">EBITDA</th>
                <th className="text-right">Margin</th>
                <th className="text-right">FTEs</th>
                <th>Founded</th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => {
                const margin = b.ttmRevenue ? b.ttmEbitda / b.ttmRevenue : 0;
                return (
                  <tr key={b.slug}>
                    <td>
                      <Link
                        href={`/portfolio/${slug}/${b.slug}`}
                        className="inline-flex items-center gap-2 text-ink hover:text-accent"
                      >
                        <Monogram label={b.name.slice(0, 2)} />
                        <div>
                          <div className="font-medium tracking-tight">{b.name}</div>
                          <div className="text-[11px] text-muted">{b.hqRegion}</div>
                        </div>
                      </Link>
                    </td>
                    <td>
                      <StatusPill>{b.status}</StatusPill>
                    </td>
                    <td className="text-ink2 text-sm">{b.segment}</td>
                    <td className="numeric text-right text-ink2">{formatPct(b.ownershipPct, 0)}</td>
                    <td className="numeric text-right text-ink font-medium">
                      {formatMoney(b.ttmRevenue)}
                    </td>
                    <td className="numeric text-right text-ink2">{formatMoney(b.ttmEbitda)}</td>
                    <td className="numeric text-right text-ink2">{formatPct(margin)}</td>
                    <td className="numeric text-right text-ink2">{formatNumber(b.fteCount)}</td>
                    <td className="text-muted text-xs whitespace-nowrap">{b.acquiredAt}</td>
                  </tr>
                );
              })}
              {businesses.length === 0 && q.isFetched && (
                <tr>
                  <td colSpan={9} className="text-muted py-8 text-center">
                    No businesses in this vertical yet.
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
