'use client';

const TONE: Record<string, string> = {
  // Application status
  PENDING: 'pill-muted',
  SUBMITTED: 'pill-info',
  IN_REVIEW: 'pill-warn',
  APPROVED: 'pill-success',
  DECLINED: 'pill-danger',
  FUNDED: 'pill-success',
  // Funding
  FAILED: 'pill-danger',
  // Lender tiers (decision context)
  PRIME: 'pill-success',
  NEAR_PRIME: 'pill-info',
  SUBPRIME: 'pill-warn',
  DEEP_SUBPRIME: 'pill-danger',
  CARD_LINKED: 'pill-muted',
  // Webhook
  RECEIVED: 'pill-info',
  PROCESSED: 'pill-success',
  REPLAYED: 'pill-warn',
  // Generic
  ACTIVE: 'pill-success',
  INACTIVE: 'pill-muted',
  CHURNED: 'pill-danger',
  // Revenue stream
  BUZZPAY: 'pill-info',
  PIXIE: 'pill-success',
  MICAMP: 'pill-warn',
  // Revenue event types
  ACCRUAL: 'pill-info',
  PIXIE_MARGIN: 'pill-success',
  PROCESSING_FEE: 'pill-info',
  CLAWBACK: 'pill-danger',
  REVERSAL: 'pill-danger',
  ADJUSTMENT: 'pill-muted',
};

export function StatusPill({ children }: { children: string }): JSX.Element {
  const cls = TONE[children] ?? 'pill-muted';
  const label = children.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return <span className={`pill ${cls}`}>{label}</span>;
}
