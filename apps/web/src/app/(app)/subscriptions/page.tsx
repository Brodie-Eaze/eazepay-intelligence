'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: string;
}
interface DeliveryRow {
  id: string;
  subscriptionName: string;
  url: string;
  eventType: string;
  status: string;
  attemptCount: number;
  lastResponseCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

const EVENT_TYPES = [
  'application.created',
  'application.status_changed',
  'lender.decision',
  'funding.completed',
  'funding.failed',
  'revenue.event',
  'pixie.usage_reported',
  'partner.onboarded',
  'partner.tier_changed',
] as const;

export default function OutboundWebhooksPage(): JSX.Element {
  const qc = useQueryClient();
  const subs = useQuery({
    queryKey: ['webhook-subscriptions'],
    queryFn: () => api<SubscriptionRow[]>('/webhook-subscriptions'),
  });
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries'],
    queryFn: () => api<DeliveryRow[]>('/webhook-deliveries?limit=50'),
    refetchInterval: 8_000,
  });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ id: string; signingSecret: string } | null>(null);

  const create = useMutation({
    mutationFn: (input: { name: string; url: string; eventTypes: string[] }) =>
      api<{ id: string; signingSecret: string }>('/webhook-subscriptions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['webhook-subscriptions'] });
      setReveal(data);
      setShowForm(false);
      setName('');
      setUrl('');
      setChosen([]);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/webhook-subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-subscriptions'] }),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api(`/webhook-subscriptions/${id}/test`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-deliveries'] }),
  });

  const subRows = subs.data ?? [];
  const dRows = deliveries.data ?? [];
  const activeSubs = subRows.filter((s) => s.isActive).length;
  const lastHourFails = dRows.filter(
    (d) => d.status === 'FAILED' || d.status === 'ABANDONED',
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outbound webhooks"
        subtitle="Push platform events to your systems. HMAC-signed. Auto-retry with exponential backoff."
        action={
          <button
            onClick={() => {
              setShowForm(!showForm);
              setReveal(null);
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-ink text-surface font-medium hover:bg-ink2"
          >
            {showForm ? 'Cancel' : '+ New subscription'}
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Subscriptions"
          value={subRows.length.toString()}
          hint={`${activeSubs} active`}
        />
        <KpiCard label="Recent deliveries" value={dRows.length.toString()} hint="last 50" />
        <KpiCard
          label="Failed (recent)"
          value={lastHourFails.toString()}
          hint="will retry until exhausted"
        />
        <KpiCard
          label="Event types"
          value={EVENT_TYPES.length.toString()}
          hint="available to subscribe"
        />
      </div>

      {reveal && (
        <SectionCard
          title="Signing secret. Copy it now."
          subtitle="This is the only time the secret is shown. Use it to verify HMAC signatures on inbound deliveries."
        >
          <div className="bg-paper border border-line rounded-md p-3 font-mono text-sm break-all">
            {reveal.signingSecret}
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(reveal.signingSecret)}
            className="mt-3 text-xs px-3 py-1.5 rounded-md border border-line hover:bg-paper"
          >
            Copy
          </button>
          <button
            onClick={() => setReveal(null)}
            className="ml-2 text-xs text-muted hover:text-ink"
          >
            I&apos;ve saved it
          </button>
        </SectionCard>
      )}

      {showForm && (
        <SectionCard title="Create subscription">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label className="block md:col-span-1">
              <span className="h-section block mb-1.5">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Internal Slack relay"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="h-section block mb-1.5">URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-system.example/eazepay"
                className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="mt-4">
            <span className="h-section block mb-2">Event types</span>
            <div className="flex flex-wrap gap-1.5">
              {EVENT_TYPES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() =>
                    setChosen((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))
                  }
                  className={`px-2.5 py-1 text-xs rounded-md border ${chosen.includes(e) ? 'border-accent text-accent bg-accentSoft' : 'border-line text-ink2 hover:bg-paper'}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={() => create.mutate({ name, url, eventTypes: chosen })}
              disabled={create.isPending || !name || !url || chosen.length === 0}
              className="px-4 py-2 rounded-md bg-accent text-surface text-sm font-medium disabled:opacity-50 hover:bg-accent/90"
            >
              {create.isPending ? 'Creating…' : 'Create + show signing secret'}
            </button>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title={`${subRows.length} subscription${subRows.length === 1 ? '' : 's'}`}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {subRows.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium text-ink">{s.name}</td>
                  <td className="font-mono text-xs text-muted truncate max-w-[280px]">{s.url}</td>
                  <td className="text-xs text-ink2">{s.eventTypes.join(', ')}</td>
                  <td>
                    <StatusPill>{s.isActive ? 'ACTIVE' : 'INACTIVE'}</StatusPill>
                  </td>
                  <td className="text-right space-x-3">
                    <button
                      onClick={() => test.mutate(s.id)}
                      className="text-[11px] text-accent hover:underline"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Delete subscription. In-flight retries continue.'))
                          remove.mutate(s.id);
                      }}
                      className="text-[11px] text-danger hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {subRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted py-8 text-center">
                    No subscriptions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Recent deliveries" subtitle="Last 50." bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Subscription</th>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>HTTP</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {dRows.map((d) => (
                <tr key={d.id}>
                  <td className="numeric text-muted text-xs whitespace-nowrap">
                    {formatDateTime(d.createdAt)}
                  </td>
                  <td className="text-ink text-xs">{d.subscriptionName}</td>
                  <td>
                    <span className="tag">{d.eventType}</span>
                  </td>
                  <td>
                    <StatusPill>{d.status}</StatusPill>
                  </td>
                  <td className="numeric text-ink2 text-xs">{d.attemptCount}</td>
                  <td className="numeric text-xs text-ink2">{d.lastResponseCode ?? '—'}</td>
                  <td className="text-[11px] text-danger truncate max-w-[200px]">
                    {d.lastError ?? ''}
                  </td>
                </tr>
              ))}
              {dRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted py-8 text-center">
                    No deliveries yet.
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
