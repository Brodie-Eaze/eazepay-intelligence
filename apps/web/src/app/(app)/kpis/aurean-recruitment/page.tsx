'use client';

import { BusinessKpiPanel } from '@/components/BusinessKpiPanel';

interface AureanRecruitmentKpis {
  window: string;
  candidatesEnteredPipeline: number;
  stageMoves: number;
  placementsContracted: number;
  commissionAmount: string;
  clawbackAmount: string;
}

export default function AureanRecruitmentKpisPage(): JSX.Element {
  return (
    <BusinessKpiPanel<AureanRecruitmentKpis>
      title="Aurean Recruitment · KPIs"
      subtitle="Pipeline + placement + commission activity (30-day window)."
      endpoint="/aurean-recruitment/kpis"
      cards={[
        { label: 'Candidates entered', pick: (d) => d.candidatesEnteredPipeline },
        { label: 'Stage moves', pick: (d) => d.stageMoves },
        { label: 'Placements', pick: (d) => d.placementsContracted },
        {
          label: 'Commission',
          pick: (d) => d.commissionAmount,
          format: (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        },
        {
          label: 'Clawbacks',
          pick: (d) => d.clawbackAmount,
          format: (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        },
      ]}
    />
  );
}
