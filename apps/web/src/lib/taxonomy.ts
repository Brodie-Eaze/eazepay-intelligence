/**
 * Canonical taxonomy for status/tag/category labels rendered in the operator UI.
 *
 * SCOPE: presentation only. Wire-level (API) values are unchanged — this module
 * normalises whatever the API hands us (`PENDING`, `RUNNING`, `live`, `Live`,
 * `RECEIVED`…) into one canonical label + one Eaze tone token. Add a new
 * synonym to the alias map; never bend the API to the UI.
 *
 * WHY this exists: a Sprint F audit found `Active` / `Live` / `Enabled` / `On`
 * all rendering the same underlying state across pages, and exports/webhooks
 * each used a different vocabulary than the rest of the product. One source
 * of truth keeps the screens legible and the tests deterministic.
 */

export type Tone = 'success' | 'info' | 'warn' | 'danger' | 'muted';

/** Eaze pill class for a tone. Mirrors globals.css `.pill-*`. */
export function toneToPillClass(tone: Tone): string {
  return `pill pill-${tone}`;
}

export type TaxonomyDomain =
  | 'application'
  | 'lenderTier'
  | 'riskBand'
  | 'customer'
  | 'export'
  | 'webhook'
  | 'alertState'
  | 'alertSeverity'
  | 'revenueStream'
  | 'revenueEventType'
  | 'funding'
  | 'activityKind'
  | 'genericActive';

interface Entry {
  label: string;
  tone: Tone;
}

type DomainMap = Record<string, Entry>;

/**
 * Each domain map keys on UPPER_SNAKE for symbol-style values and lower for
 * already-lowercase values. `getLabel` / `getColor` normalise input casing.
 */
const APPLICATION: DomainMap = {
  PENDING: { label: 'Pending', tone: 'muted' },
  SUBMITTED: { label: 'Submitted', tone: 'info' },
  IN_REVIEW: { label: 'In review', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'success' },
  DECLINED: { label: 'Declined', tone: 'danger' },
  FUNDED: { label: 'Funded', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

const LENDER_TIER: DomainMap = {
  PRIME: { label: 'Prime', tone: 'success' },
  NEAR_PRIME: { label: 'Near prime', tone: 'info' },
  SUBPRIME: { label: 'Subprime', tone: 'warn' },
  DEEP_SUBPRIME: { label: 'Deep subprime', tone: 'danger' },
  CARD_LINKED: { label: 'Card-linked', tone: 'muted' },
};

const RISK_BAND: DomainMap = {
  ...LENDER_TIER,
  UNSCORED: { label: 'Unscored', tone: 'muted' },
};

/** Canonical customer status — UI label set, regardless of upstream casing. */
const CUSTOMER: DomainMap = {
  ACTIVE: { label: 'Active', tone: 'success' },
  INACTIVE: { label: 'Inactive', tone: 'muted' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  PENDING: { label: 'Pending', tone: 'warn' },
  CHURNED: { label: 'Churned', tone: 'danger' },
};

/**
 * Export status — API ships PENDING/RUNNING/COMPLETED/FAILED/EXPIRED.
 * UI presents canonical `queued/processing/ready/failed/expired`.
 */
const EXPORT: DomainMap = {
  PENDING: { label: 'Queued', tone: 'muted' },
  QUEUED: { label: 'Queued', tone: 'muted' },
  RUNNING: { label: 'Processing', tone: 'info' },
  PROCESSING: { label: 'Processing', tone: 'info' },
  COMPLETED: { label: 'Ready', tone: 'success' },
  READY: { label: 'Ready', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'muted' },
};

/**
 * Webhook status — API ships RECEIVED/PROCESSED/REPLAYED/FAILED.
 * UI presents canonical `delivered/retrying/failed`.
 */
const WEBHOOK: DomainMap = {
  RECEIVED: { label: 'Delivered', tone: 'info' },
  PROCESSED: { label: 'Delivered', tone: 'success' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  REPLAYED: { label: 'Retrying', tone: 'warn' },
  RETRYING: { label: 'Retrying', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

const ALERT_STATE: DomainMap = {
  OPEN: { label: 'Open', tone: 'danger' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'warn' },
  SNOOZED: { label: 'Snoozed', tone: 'muted' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
};

const ALERT_SEVERITY: DomainMap = {
  INFO: { label: 'Info', tone: 'info' },
  WARN: { label: 'Warn', tone: 'warn' },
  CRITICAL: { label: 'Critical', tone: 'danger' },
};

const REVENUE_STREAM: DomainMap = {
  PIXIE: { label: 'Pixie', tone: 'success' },
  MICAMP: { label: 'MiCamp', tone: 'warn' },
};

const REVENUE_EVENT_TYPE: DomainMap = {
  ACCRUAL: { label: 'Accrual', tone: 'info' },
  PIXIE_MARGIN: { label: 'Pixie margin', tone: 'success' },
  PROCESSING_FEE: { label: 'Processing fee', tone: 'info' },
  CLAWBACK: { label: 'Clawback', tone: 'danger' },
  REVERSAL: { label: 'Reversal', tone: 'danger' },
  ADJUSTMENT: { label: 'Adjustment', tone: 'muted' },
};

const FUNDING: DomainMap = {
  PENDING: { label: 'Pending', tone: 'muted' },
  FUNDED: { label: 'Funded', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

const ACTIVITY_KIND: DomainMap = {
  APPLICATION: { label: 'Application', tone: 'info' },
  DECISION: { label: 'Decision', tone: 'warn' },
  FUNDING: { label: 'Funding', tone: 'success' },
  REVENUE: { label: 'Revenue', tone: 'success' },
  PARTNER: { label: 'Partner', tone: 'muted' },
};

/**
 * Generic on/off / live / enabled — collapses the historical `Active|Live|Enabled|On`
 * and `Inactive|Disabled|Off` aliases to one pair of canonical labels + tones.
 */
const GENERIC_ACTIVE: DomainMap = {
  ACTIVE: { label: 'Active', tone: 'success' },
  LIVE: { label: 'Active', tone: 'success' },
  ENABLED: { label: 'Active', tone: 'success' },
  ON: { label: 'Active', tone: 'success' },
  TRUE: { label: 'Active', tone: 'success' },
  INACTIVE: { label: 'Inactive', tone: 'muted' },
  DISABLED: { label: 'Inactive', tone: 'muted' },
  OFF: { label: 'Inactive', tone: 'muted' },
  FALSE: { label: 'Inactive', tone: 'muted' },
};

const DOMAINS: Record<TaxonomyDomain, DomainMap> = {
  application: APPLICATION,
  lenderTier: LENDER_TIER,
  riskBand: RISK_BAND,
  customer: CUSTOMER,
  export: EXPORT,
  webhook: WEBHOOK,
  alertState: ALERT_STATE,
  alertSeverity: ALERT_SEVERITY,
  revenueStream: REVENUE_STREAM,
  revenueEventType: REVENUE_EVENT_TYPE,
  funding: FUNDING,
  activityKind: ACTIVITY_KIND,
  genericActive: GENERIC_ACTIVE,
};

function normaliseKey(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase().replace(/[\s-]/g, '_');
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve the canonical UI label for a value in a taxonomy domain.
 * Falls back to a title-cased version of the raw value if unknown — never throws.
 */
export function getLabel(
  domain: TaxonomyDomain,
  value: string | number | boolean | null | undefined,
): string {
  const key = normaliseKey(value);
  if (!key) return '—';
  const entry = DOMAINS[domain][key];
  return entry?.label ?? titleCase(key);
}

/** Resolve the canonical Eaze tone for a value. Falls back to `muted`. */
export function getColor(
  domain: TaxonomyDomain,
  value: string | number | boolean | null | undefined,
): Tone {
  const key = normaliseKey(value);
  if (!key) return 'muted';
  return DOMAINS[domain][key]?.tone ?? 'muted';
}

/** Convenience: canonical label + pill class string ready to drop into JSX. */
export function getPill(
  domain: TaxonomyDomain,
  value: string | number | boolean | null | undefined,
): { label: string; className: string } {
  return {
    label: getLabel(domain, value),
    className: toneToPillClass(getColor(domain, value)),
  };
}

/**
 * Stable, alphabetised option list for filter dropdowns — keys are the API
 * wire values, labels are canonical. De-duped by label so `PENDING`/`QUEUED`
 * collapse to one `Queued` option for the operator.
 */
export function listOptions(domain: TaxonomyDomain): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  for (const [value, entry] of Object.entries(DOMAINS[domain])) {
    if (seen.has(entry.label)) continue;
    seen.add(entry.label);
    out.push({ value, label: entry.label });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
