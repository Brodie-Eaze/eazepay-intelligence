'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { Shield, Lock } from 'lucide-react';

/**
 * /highsale/[id] — single-snapshot drill page.
 *
 * Shows every one of the ~70 fields HighSale sent for a given pull,
 * grouped by the logical blocks from the JSON spec. Each block becomes
 * a card; each field is one row of `name → value` with the on-disk
 * column name visible (so engineers know exactly where to query).
 *
 * The "schema landing" Brodie asked for: the full field mapping from
 * HighSale → credit_enrichments → marts, visible per-snapshot.
 */

interface SnapshotDetail {
  id: string;
  orgId: string;
  vertical: 'medpay' | 'tradepay' | 'coachpay';
  pulledAt: string;
  receivedAt: string;
  highsaleTransactionId: string;
  applicationId: string | null;
  externalApplicationId: string | null;
  consumerEmailHash: string;
  consumerPhoneHash: string;
  dateOfBirthHash: string;
  blocks: {
    pii: Record<string, unknown>;
    lookup_flags: Record<string, boolean>;
    grades: Record<string, number>;
    decision_rates: Record<string, string>;
    inquiry_quotas: Record<string, number>;
    credit_profile: Record<string, number | string>;
    qualification: Record<string, unknown>;
    tradeline_detail: Record<string, number | string>;
    adverse_events: Record<string, number>;
    ml_score: Record<string, string>;
    demographics_protected: Record<string, string | null>;
  };
  rawPayload: unknown;
}

const BLOCK_META: Record<
  keyof SnapshotDetail['blocks'],
  { title: string; subtitle: string; sensitive?: boolean; protectedClass?: boolean }
> = {
  pii: {
    title: 'Application form data (PII)',
    subtitle:
      'Echo of the consumer submission. Plaintext is AES-256-GCM encrypted at rest; only hashes + stated income surface here.',
    sensitive: true,
  },
  lookup_flags: {
    title: 'Lookup outcome',
    subtitle: 'Bureau response metadata — was the file frozen, hit, missing?',
  },
  grades: {
    title: 'HighSale grades',
    subtitle: '10 categorical grades the proprietary engine emits for each axis.',
  },
  decision_rates: {
    title: 'Decision rates',
    subtitle: "HighSale's lookback approval / decline rates for similar profiles.",
  },
  inquiry_quotas: {
    title: 'Remaining inquiry quotas',
    subtitle: 'Hard-pull budget remaining by inquiry class.',
  },
  credit_profile: {
    title: 'Aggregate credit profile',
    subtitle: 'Lines, utilisation, trended income/debt — the core credit picture.',
  },
  qualification: {
    title: 'Qualification outputs',
    subtitle: 'Pass/fail + BNPL + consumer-loan splits, funding estimates, DQ reasons.',
  },
  tradeline_detail: {
    title: 'Tradeline detail',
    subtitle:
      '28 fields covering specific tradeline types, time windows, balances, and product categories.',
  },
  adverse_events: {
    title: 'Adverse events',
    subtitle: 'Charge-offs, repos, foreclosures — historical defaults that surfaced.',
  },
  ml_score: {
    title: 'HighSale ML output',
    subtitle: 'Proprietary sale-confidence score.',
  },
  demographics_protected: {
    title: 'Demographics (PROTECTED CLASS)',
    subtitle:
      'FCRA / fair-lending protected fields. Captured for disparate-impact monitoring only — NEVER feeds underwriting or routing.',
    protectedClass: true,
  },
};

const BLOCK_ORDER: Array<keyof SnapshotDetail['blocks']> = [
  'qualification',
  'grades',
  'credit_profile',
  'decision_rates',
  'tradeline_detail',
  'adverse_events',
  'ml_score',
  'inquiry_quotas',
  'lookup_flags',
  'pii',
  'demographics_protected',
];

export default function SnapshotDetailPage({ params }: { params: { id: string } }): JSX.Element {
  const q = useQuery({
    queryKey: ['highsale.snapshot', params.id],
    queryFn: () => api<SnapshotDetail>(`/highsale/snapshots/${params.id}`),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Loading snapshot…" subtitle="—" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div>
        <PageHeader title="Snapshot not found" subtitle="—" />
        <div className="card card-pad text-danger">
          Could not load credit_enrichments row {params.id}.
        </div>
      </div>
    );
  }

  const d = q.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="HighSale snapshot"
        crumbs={[
          { label: 'Data sources', href: '/data-sources' },
          { label: 'HighSale', href: '/highsale' },
          { label: d.highsaleTransactionId.slice(0, 8) + '…' },
        ]}
        subtitle={
          <>
            Pulled {formatDateTime(d.pulledAt)} ·{' '}
            <span className="tag capitalize">{d.vertical}</span> · transaction{' '}
            <code className="kbd">{d.highsaleTransactionId}</code>
          </>
        }
        status={
          d.blocks.qualification.is_qualified_bnpl
            ? { label: 'BNPL APPROVED', tone: 'live' }
            : { label: 'BNPL DECLINED', tone: 'idle' }
        }
        action={
          <Link
            href={`/customers/${d.consumerEmailHash}`}
            className="text-xs px-3 py-1.5 rounded-md border border-line2 text-ink2 hover:bg-paper hover:border-accent transition"
          >
            View customer →
          </Link>
        }
      />

      {/* ── Identity strip ────────────────────────────────────────────── */}
      <SectionCard
        title="Identity & linkage"
        subtitle="how this row joins back into the warehouse"
        bodyClassName="p-0"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-line2 border-t border-line2">
          <IdentityField label="credit_enrichments.id" value={d.id} mono />
          <IdentityField label="HighSale transaction" value={d.highsaleTransactionId} mono />
          <IdentityField
            label="External application id"
            value={d.externalApplicationId ?? '— (correlation token not passed)'}
          />
          <IdentityField
            label="Internal application id"
            value={d.applicationId ?? '— (not yet resolved)'}
            mono
          />
          <IdentityField label="Org id" value={d.orgId} mono />
          <IdentityField
            label="Email hash (sha256·HMAC)"
            value={`${d.consumerEmailHash.slice(0, 24)}…`}
            mono
          />
        </div>
      </SectionCard>

      {/* ── Logical blocks ────────────────────────────────────────────── */}
      {BLOCK_ORDER.map((key) => {
        const meta = BLOCK_META[key];
        const block = d.blocks[key];
        const entries = Object.entries(block).filter(([k]) => !k.startsWith('_'));
        if (entries.length === 0) return null;

        return (
          <SectionCard
            key={key}
            title={
              <span className="flex items-center gap-2">
                {meta.sensitive && <Lock size={13} className="text-amber-600" />}
                {meta.protectedClass && <Shield size={13} className="text-rose-600" />}
                {meta.title}
                <span className="text-[10px] text-muted font-normal numeric ml-1">
                  {entries.length} field{entries.length === 1 ? '' : 's'}
                </span>
              </span>
            }
            subtitle={meta.subtitle}
            bodyClassName="p-0"
          >
            {meta.protectedClass && (
              <div className="px-5 py-2.5 bg-rose-500/5 border-y border-rose-500/20 text-[11px] text-rose-700">
                <strong>Restricted use.</strong> These fields exist for disparate-impact monitoring
                + aggregate market sizing only. They MUST NOT feed underwriting, routing,
                approval-rate optimisation, or any decisioning analytics. Every read is audited via
                PROTECTED_CLASS_READ.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="w-1/2">Field</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([fieldName, value]) => (
                    <tr key={fieldName}>
                      <td>
                        <code className="text-[12px] text-ink font-mono">{fieldName}</code>
                      </td>
                      <td className="text-ink2">{renderValue(fieldName, value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {'_note' in block && typeof block._note === 'string' && (
              <div className="px-5 py-2 border-t border-line2 text-[11px] text-muted">
                <Lock size={11} className="inline mr-1" />
                {block._note}
              </div>
            )}
          </SectionCard>
        );
      })}

      {/* ── Raw payload ───────────────────────────────────────────────── */}
      <SectionCard
        title="Raw HighSale payload"
        subtitle="forensic completeness · the exact bytes HighSale sent us"
        bodyClassName="p-0"
        collapsible
        defaultOpen={false}
      >
        <pre className="text-[11px] leading-relaxed bg-[#0F172A] text-[#E2E8F0] px-5 py-4 overflow-x-auto rounded-b-xl font-mono max-h-[400px] overflow-y-auto">
          {JSON.stringify(d.rawPayload, null, 2)}
        </pre>
      </SectionCard>
    </div>
  );
}

function IdentityField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="px-5 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">{label}</div>
      <div className={mono ? 'font-mono text-[11px] text-ink2 break-all' : 'text-[13px] text-ink2'}>
        {value}
      </div>
    </div>
  );
}

function renderValue(field: string, value: unknown): JSX.Element | string {
  if (value === null || value === undefined) return <span className="text-soft">—</span>;
  if (typeof value === 'boolean') {
    return value ? (
      <StatusPill>{'TRUE'}</StatusPill>
    ) : (
      <span className="text-muted text-xs uppercase tracking-wider">false</span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-soft">[ ]</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((v, i) => (
          <span key={i} className="tag text-[11px]">
            {String(v)}
          </span>
        ))}
      </div>
    );
  }
  if (typeof value === 'number') {
    if (field.endsWith('_cents')) {
      return <span className="numeric">{formatMoney(value / 100)}</span>;
    }
    return <span className="numeric">{value.toLocaleString('en-AU')}</span>;
  }
  if (typeof value === 'string') {
    // Decimal strings (e.g. utilization)
    if (/^-?\d+\.\d+$/.test(value)) {
      const n = Number(value);
      // 0..1 ranges presented as percent
      if (n >= 0 && n <= 1.5 && field.match(/rate|utilization|score|percent/)) {
        return <span className="numeric">{(n * 100).toFixed(2)}%</span>;
      }
      return <span className="numeric">{n.toLocaleString('en-AU')}</span>;
    }
    return value;
  }
  return JSON.stringify(value);
}
