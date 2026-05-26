'use client';

import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';

/**
 * Platform changelog. Reverse-chronological. Sentence case, direct voice.
 * Every entry should map to a shipped commit or release tag — do not list
 * planned work here.
 */

type EntryKind = 'security' | 'platform' | 'docs' | 'data';

interface Entry {
  date: string;
  kind: EntryKind;
  title: string;
  details: string[];
}

const ENTRIES: Entry[] = [
  {
    date: '2026-05-27',
    kind: 'security',
    title: 'Hardening sweep',
    details: [
      'Closed 17 audit findings across web, API, and worker tiers',
      'Per-tenant WebSocket channel filter — events no longer fan out across organizations',
      'Rate-limit environment gate restored on auth and token endpoints',
      'Structured logging with organization_id and request_id on every state change',
    ],
  },
  {
    date: '2026-05-26',
    kind: 'docs',
    title: 'Engineering reference published',
    details: [
      'Public reference page covering data model, API surface, and runbooks',
      'Scroll-spy table of contents and copyable code samples',
    ],
  },
  {
    date: '2026-05-20',
    kind: 'security',
    title: 'Multi-tenant row-level security enforcement',
    details: [
      'Postgres RLS policies enabled on every tenant-scoped table',
      'API and worker connections run as the tenant role; cross-tenant reads denied at the database',
    ],
  },
  {
    date: '2026-05-15',
    kind: 'security',
    title: 'AES-256-GCM envelope encryption',
    details: [
      'Per-organization data encryption keys, wrapped by a regional KMS key',
      'Key rotation runbook documented; backfill job ships keys within 24 hours of rotation',
    ],
  },
  {
    date: '2026-05-08',
    kind: 'platform',
    title: 'BullMQ worker pool',
    details: [
      'Replaced ad-hoc cron with BullMQ for accruals, reconciliation, and exports',
      'Idempotency keys carried on every state-changing job',
    ],
  },
  {
    date: '2026-04-29',
    kind: 'data',
    title: 'HighSale schema dictionary',
    details: [
      '70-field dictionary published under Reference',
      'Per-field type, source system, and PII classification',
    ],
  },
  {
    date: '2026-04-22',
    kind: 'platform',
    title: 'Append-only revenue ledger',
    details: [
      'Reversals and clawbacks written as new entries; running balance derived',
      'Reconciliation report compares ledger to MiCamp and Pixie settlement files',
    ],
  },
  {
    date: '2026-04-10',
    kind: 'security',
    title: 'MFA enforcement for ADMIN role',
    details: [
      'Step-up challenge on sensitive admin actions',
      'TOTP via authenticator app; recovery codes issued at enrolment',
    ],
  },
];

const KIND_TONE: Record<EntryKind, string> = {
  security: 'bg-emerald-500/10 text-emerald-700',
  platform: 'bg-accentSoft text-accent',
  docs: 'bg-line2 text-ink2',
  data: 'bg-amber-500/10 text-amber-700',
};

const KIND_LABEL: Record<EntryKind, string> = {
  security: 'Security',
  platform: 'Platform',
  docs: 'Docs',
  data: 'Data',
};

function formatDate(iso: string): string {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ChangelogPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Changelog"
        subtitle="Shipped changes to the EazePay Intelligence platform"
      />

      <SectionCard title="Releases" subtitle="Latest first">
        <ol className="space-y-6">
          {ENTRIES.map((e) => (
            <li
              key={e.date + e.title}
              className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-2 md:gap-6"
            >
              <div className="text-[12px] text-muted tabular-nums">{formatDate(e.date)}</div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-ink">{e.title}</h3>
                  <span
                    className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${KIND_TONE[e.kind]}`}
                  >
                    {KIND_LABEL[e.kind]}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-ink2 list-disc pl-5 marker:text-soft">
                  {e.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>
    </div>
  );
}
