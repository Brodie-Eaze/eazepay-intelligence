/**
 * Event-type catalogue for HighSale business events (GAP-105).
 *
 * Distinct from the Plane-2 /integration/highsale/snapshots route which
 * persists credit_enrichments rows. This catalogue covers the operational
 * stream — inquiries, risk-band assignments, lifecycle transitions on
 * the HighSale platform itself. Those events drive HighSale's own KPI
 * dashboard inside Intelligence.
 *
 * Wire transport: HMAC-signed POST /integration/highsale/events (separate
 * from the snapshots route which carries credit-enrichment payloads).
 */

export const HIGHSALE_BUSINESS_EVENT_TYPES = [
  /** A consumer submitted a credit-check inquiry. Subject = `Inquiry`. */
  'inquiry.submitted',
  /** A risk band was assigned to an applicant. Subject = `Inquiry`. */
  'risk_band.assigned',
  /** A snapshot was generated (links to /integration/highsale/snapshots). */
  'snapshot.generated',
  /** A revenue event accrued from the HighSale business. */
  'revenue.recorded',
] as const;

export type HighSaleBusinessEventType = (typeof HIGHSALE_BUSINESS_EVENT_TYPES)[number];

export function isKnownHighSaleBusinessEventType(s: string): s is HighSaleBusinessEventType {
  return (HIGHSALE_BUSINESS_EVENT_TYPES as readonly string[]).includes(s);
}

export const EVENT_SUBJECT_TYPE: Record<HighSaleBusinessEventType, string> = {
  'inquiry.submitted': 'Inquiry',
  'risk_band.assigned': 'Inquiry',
  'snapshot.generated': 'CreditEnrichment',
  'revenue.recorded': 'RevenueEvent',
};
