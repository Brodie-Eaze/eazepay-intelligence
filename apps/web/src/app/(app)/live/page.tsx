'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { LiveTicker } from '@/components/LiveTicker';
import { useLiveTicker } from '@/components/LiveTickerContext';
import { RecentActivityTable, type ActivityRow } from '@/components/RecentActivityTable';

export default function LiveActivityPage(): JSX.Element {
  const { events, connected } = useLiveTicker();
  const tail = useQuery({
    queryKey: ['analytics.live'],
    queryFn: () => api<ActivityRow[]>('/analytics/live'),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live activity"
        subtitle="Server-pushed events + database tail · the platform's nervous system in real time"
        action={
          <span className={`pill ${connected ? 'pill-success' : 'pill-danger'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-danger'}`} />
            {connected ? 'Live' : 'Reconnecting'}
          </span>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard
          title="WebSocket stream"
          subtitle={`${events.length} events buffered in this session`}
          bodyClassName="p-0"
        >
          <LiveTicker events={events} />
        </SectionCard>

        <SectionCard
          title="Database tail"
          subtitle="last 50 events from applications / decisions / fundings / revenue"
          bodyClassName="p-0"
        >
          <RecentActivityTable rows={tail.data ?? []} />
        </SectionCard>
      </div>
    </div>
  );
}
