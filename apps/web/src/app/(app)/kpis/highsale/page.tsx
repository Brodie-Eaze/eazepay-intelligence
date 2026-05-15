'use client';

import { BusinessKpiPanel } from '@/components/BusinessKpiPanel';

interface HighSaleKpis {
  window: string;
  inquiries: number;
  riskBandsAssigned: number;
  snapshotsGenerated: number;
  revenueAmount: string;
}

export default function HighSaleKpisPage(): JSX.Element {
  return (
    <BusinessKpiPanel<HighSaleKpis>
      title="HighSale · KPIs"
      subtitle="Inquiry, risk-band assignment, and snapshot generation (30-day window)."
      endpoint="/highsale/kpis"
      cards={[
        { label: 'Inquiries', pick: (d) => d.inquiries },
        { label: 'Risk bands', pick: (d) => d.riskBandsAssigned },
        { label: 'Snapshots', pick: (d) => d.snapshotsGenerated },
        {
          label: 'Revenue',
          pick: (d) => d.revenueAmount,
          format: (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        },
      ]}
    />
  );
}
