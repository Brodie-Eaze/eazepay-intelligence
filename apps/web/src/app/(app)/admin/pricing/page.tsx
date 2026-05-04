'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { Monogram } from '@/components/Monogram';

interface PartnerRow {
  id: string;
  externalId: string;
  name: string;
  industry: string;
  buzzpayRevSharePct: string;
  pixieDataPullCost: string;
  pixieChargeRate: string;
  pixieMargin: string;
  contractValue: string;
}

export default function PricingConfigPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['admin.pricing'],
    queryFn: () => api<{ data: PartnerRow[] }>('/partners?limit=100'),
  });

  const rows = q.data?.data ?? [];
  const totalContract = rows.reduce((s, r) => s + Number(r.contractValue), 0);
  const avgPixieMargin = rows.length
    ? rows.reduce((s, r) => s + Number(r.pixieMargin), 0) / rows.length
    : 0;
  const avgRevShare = rows.length
    ? rows.reduce((s, r) => s + Number(r.buzzpayRevSharePct), 0) / rows.length
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pricing"
        subtitle="Per-partner commercial terms · BuzzPay rev share · Pixie sliding-scale"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Pixie breakpoint" value="25,000" hint="env · collective pulls / day" />
        <KpiCard label="Avg Pixie margin" value={`$${avgPixieMargin.toFixed(2)}`} hint="per partner per pull" />
        <KpiCard label="Avg rev share" value={`${(avgRevShare * 100).toFixed(2)}%`} hint="BuzzPay funded" />
        <KpiCard label="Contract value" value={formatMoney(totalContract)} hint="across the network" />
      </div>

      <SectionCard
        title={`${rows.length} active partners`}
        subtitle="edit pricing per partner via the partner detail screen"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Partner</th>
                <th>External ID</th>
                <th>Industry</th>
                <th className="text-right">Contract value</th>
                <th className="text-right">BuzzPay rev share</th>
                <th className="text-right">Pixie cost / pull</th>
                <th className="text-right">Pixie charge / pull</th>
                <th className="text-right">Pixie margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/partners/${p.id}`} className="inline-flex items-center gap-2 text-ink hover:text-accent">
                      <Monogram label={p.name} />
                      <span className="font-medium tracking-tight">{p.name}</span>
                    </Link>
                  </td>
                  <td><span className="tag">{p.externalId}</span></td>
                  <td className="text-ink2 text-sm">{p.industry}</td>
                  <td className="numeric text-right text-ink">{formatMoney(p.contractValue)}</td>
                  <td className="numeric text-right text-ink2">{(Number(p.buzzpayRevSharePct) * 100).toFixed(2)}%</td>
                  <td className="numeric text-right text-ink2">${Number(p.pixieDataPullCost).toFixed(2)}</td>
                  <td className="numeric text-right text-ink2">${Number(p.pixieChargeRate).toFixed(2)}</td>
                  <td className="numeric text-right text-success font-medium">${Number(p.pixieMargin).toFixed(2)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="text-muted py-8 text-center">No partners.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
