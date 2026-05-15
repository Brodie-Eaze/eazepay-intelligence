'use client';

import { BusinessKpiPanel } from '@/components/BusinessKpiPanel';

interface AureanAiKpis {
  window: string;
  inferenceRuns: number;
  scoresPublished: number;
  revenueAmount: string;
  lastInferenceAt: string | null;
}

export default function AureanAiKpisPage(): JSX.Element {
  return (
    <BusinessKpiPanel<AureanAiKpis>
      title="Aurean AI · KPIs"
      subtitle="Inference activity + revenue accrual for the Aurean AI inference platform."
      endpoint="/aurean-ai/kpis"
      cards={[
        { label: 'Inference runs', pick: (d) => d.inferenceRuns },
        { label: 'Scores published', pick: (d) => d.scoresPublished },
        {
          label: 'Revenue (7d)',
          pick: (d) => d.revenueAmount,
          format: (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        },
        {
          label: 'Last inference',
          pick: (d) => d.lastInferenceAt ?? '—',
          format: (v) =>
            v === '—'
              ? '—'
              : new Date(String(v)).toLocaleString(undefined, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                }),
        },
      ]}
    />
  );
}
