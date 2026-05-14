'use client';

import { formatTime } from '@/lib/format';
import type { WsEvent } from '@/lib/types';

const TONE: Record<string, string> = {
  'application.created': 'pill-info',
  'application.status_changed': 'pill-muted',
  'lender.decision': 'pill-warn',
  'funding.completed': 'pill-success',
  'funding.failed': 'pill-danger',
  'revenue.event': 'pill-success',
  'pixie.usage_reported': 'pill-muted',
  'partner.onboarded': 'pill-info',
  'partner.tier_changed': 'pill-muted',
  'system.heartbeat': 'pill-muted',
};

const KIND_LABEL: Record<string, string> = {
  'application.created': 'App',
  'application.status_changed': 'Status',
  'lender.decision': 'Decision',
  'funding.completed': 'Funded',
  'funding.failed': 'Failed',
  'revenue.event': 'Revenue',
  'pixie.usage_reported': 'Pixie',
  'partner.onboarded': 'Onboard',
  'partner.tier_changed': 'Tier',
  'system.heartbeat': '·',
};

interface Props {
  events: WsEvent[];
}

export function LiveTicker({ events }: Props): JSX.Element {
  const visible = events.filter((e) => e.type !== 'system.heartbeat').slice(0, 60);
  if (visible.length === 0) {
    return (
      <div className="text-sm text-muted px-5 py-6 text-center">
        Waiting for events…
        <div className="text-[11px] mt-2 text-muted/70">
          Webhooks from Pixie / MiCamp / EazePay App will stream here in real time.
        </div>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line max-h-[460px] overflow-auto">
      {visible.map((evt, idx) => (
        <li key={`${evt.at}-${idx}`} className="flex items-center gap-3 px-5 py-2 text-xs">
          <span className="numeric text-muted w-16 shrink-0">{formatTime(evt.at)}</span>
          <span className={`pill ${TONE[evt.type] ?? 'pill-muted'} w-20 justify-center shrink-0`}>
            {KIND_LABEL[evt.type] ?? '·'}
          </span>
          <span className="flex-1 text-ink2">{describe(evt)}</span>
        </li>
      ))}
    </ul>
  );
}

function describe(evt: WsEvent): string {
  switch (evt.type) {
    case 'application.created':
      return `New application · ${evt.partnerLabel}`;
    case 'application.status_changed':
      return `${evt.partnerLabel} · ${evt.from} → ${evt.to}`;
    case 'lender.decision':
      return `${evt.partnerLabel} · ${evt.lender} ${evt.outcome}${evt.amount ? ` · $${evt.amount}` : ''}`;
    case 'funding.completed':
      return `${evt.partnerLabel} · funded $${evt.amount}`;
    case 'funding.failed':
      return `${evt.partnerLabel} · ${evt.reason}`;
    case 'revenue.event':
      return `${evt.partnerLabel} · ${evt.stream} ${evt.eventType} · $${evt.amount}`;
    case 'pixie.usage_reported':
      return `${evt.partnerLabel} · ${evt.pulls.toLocaleString()} pulls`;
    case 'partner.onboarded':
      return `${evt.partnerLabel} (${evt.tier})`;
    case 'partner.tier_changed':
      return `${evt.partnerLabel} · ${evt.from} → ${evt.to}`;
    case 'system.heartbeat':
      return 'heartbeat';
  }
}
