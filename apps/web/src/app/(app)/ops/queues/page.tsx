'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { KpiCard } from '@/components/KpiCard';

interface Health {
  redis: { queueDepth: { webhook: number; webhookActive: number; webhookFailed: number; aggregation: number } };
}

export default function QueuesPage(): JSX.Element {
  const q = useQuery({
    queryKey: ['ops.queues'],
    queryFn: () => api<Health>('/admin/health'),
    refetchInterval: 5_000,
  });

  const d = q.data?.redis.queueDepth;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Queues & workers"
        subtitle="BullMQ depth refreshed every 5s · webhook worker @ concurrency 8 · aggregation worker @ concurrency 2"
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Webhook · waiting" value={d ? formatNumber(d.webhook) : '…'} hint="inbound buffer" />
        <KpiCard label="Webhook · active" value={d ? formatNumber(d.webhookActive) : '…'} hint="being processed now" />
        <KpiCard label="Webhook · failed" value={d ? formatNumber(d.webhookFailed) : '…'} hint={d?.webhookFailed ? 'inspect & replay' : 'all green'} />
        <KpiCard label="Aggregation · waiting" value={d ? formatNumber(d.aggregation) : '…'} hint="rollup queue" />
      </div>

      <SectionCard title="Worker processes" subtitle="run as separate Node processes in production">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between border-b border-line/60 pb-2">
            <div>
              <div className="text-ink font-medium">webhook.worker</div>
              <div className="text-xs text-muted">processes inbound webhooks · writes RevenueEvent · publishes WS</div>
            </div>
            <code className="kbd">pnpm --filter api worker:webhook</code>
          </div>
          <div className="flex items-center justify-between border-b border-line/60 pb-2">
            <div>
              <div className="text-ink font-medium">aggregation.worker</div>
              <div className="text-xs text-muted">rolls up RevenueAggregation rows nightly + on-write</div>
            </div>
            <code className="kbd">pnpm --filter api worker:aggregation</code>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink font-medium">revenue.worker</div>
              <div className="text-xs text-muted">enqueues period closes (cron-driven)</div>
            </div>
            <code className="kbd">pnpm --filter api worker:revenue</code>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
