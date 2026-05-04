'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatNumber, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';

interface FunnelResponse { submitted: number; approved: number; funded: number }

export default function FunnelPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['analytics.funnel'],
    queryFn: () => api<FunnelResponse>('/analytics/funnel'),
  });

  const f = q.data ?? { submitted: 0, approved: 0, funded: 0 };
  const submittedToApproved = f.submitted ? f.approved / f.submitted : 0;
  const approvedToFunded = f.approved ? f.funded / f.approved : 0;
  const overall = f.submitted ? f.funded / f.submitted : 0;

  const stages: Array<{ label: string; count: number; pct: number; tone: 'accent' | 'success' }> = [
    { label: 'Submitted', count: f.submitted, pct: 1, tone: 'accent' },
    { label: 'Approved', count: f.approved, pct: submittedToApproved, tone: 'accent' },
    { label: 'Funded', count: f.funded, pct: overall, tone: 'success' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Funnel" subtitle="Application → approval → funding · last 30 days" />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Submitted" value={formatNumber(f.submitted)} hint="entered the funnel" />
        <KpiCard label="Approved" value={formatNumber(f.approved)} hint={formatPct(submittedToApproved)} />
        <KpiCard label="Funded" value={formatNumber(f.funded)} hint={formatPct(approvedToFunded) + ' of approved'} />
        <KpiCard label="Overall" value={formatPct(overall)} hint="submitted → funded" />
      </div>

      <SectionCard title="Conversion stages" subtitle="drop-off shown vs the prior stage">
        <div className="space-y-5">
          {stages.map((s) => (
            <div key={s.label}>
              <div className="flex items-baseline justify-between text-xs mb-2">
                <span className="text-muted font-medium uppercase tracking-wider">{s.label}</span>
                <span className="numeric text-ink font-semibold">
                  {formatNumber(s.count)} <span className="text-muted">· {(s.pct * 100).toFixed(1)}%</span>
                </span>
              </div>
              <MiniBar value={s.pct} tone={s.tone} className="h-3" />
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
