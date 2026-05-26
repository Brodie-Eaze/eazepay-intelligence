'use client';

import { getLabel, getColor, toneToPillClass, type TaxonomyDomain } from '@/lib/taxonomy';

/**
 * Legacy TONE map kept ONLY as a fallback for call sites that haven't been
 * migrated to pass a `domain`. New code: pass `domain={...}` so the canonical
 * taxonomy in `@/lib/taxonomy` is the single source of truth.
 */
const LEGACY_TONE: Record<string, string> = {
  PENDING: 'pill-muted',
  SUBMITTED: 'pill-info',
  IN_REVIEW: 'pill-warn',
  APPROVED: 'pill-success',
  DECLINED: 'pill-danger',
  FUNDED: 'pill-success',
  FAILED: 'pill-danger',
  PRIME: 'pill-success',
  NEAR_PRIME: 'pill-info',
  SUBPRIME: 'pill-warn',
  DEEP_SUBPRIME: 'pill-danger',
  CARD_LINKED: 'pill-muted',
  RECEIVED: 'pill-info',
  PROCESSED: 'pill-success',
  REPLAYED: 'pill-warn',
  ACTIVE: 'pill-success',
  INACTIVE: 'pill-muted',
  CHURNED: 'pill-danger',
  PIXIE: 'pill-success',
  MICAMP: 'pill-warn',
  ACCRUAL: 'pill-info',
  PIXIE_MARGIN: 'pill-success',
  PROCESSING_FEE: 'pill-info',
  CLAWBACK: 'pill-danger',
  REVERSAL: 'pill-danger',
  ADJUSTMENT: 'pill-muted',
};

interface Props {
  children: string;
  /** Opt into canonical taxonomy in `@/lib/taxonomy`. Prefer this in new code. */
  domain?: TaxonomyDomain;
}

export function StatusPill({ children, domain }: Props): JSX.Element {
  if (domain) {
    const cls = toneToPillClass(getColor(domain, children));
    return <span className={cls}>{getLabel(domain, children)}</span>;
  }
  const key = (children ?? '').toUpperCase();
  const cls = LEGACY_TONE[key] ?? 'pill-muted';
  const label = (children ?? '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return <span className={`pill ${cls}`}>{label}</span>;
}
