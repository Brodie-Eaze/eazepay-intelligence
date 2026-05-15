/**
 * Event-type catalogue for the Aurean Recruitment integration (GAP-104).
 *
 * Aurean Recruitment is a placement-fee business. Lifecycle events flow
 * from the ATS to EazePay Intelligence so revenue accrual + pipeline
 * KPIs can be reported per-tenant.
 */

export const AUREAN_RECRUITMENT_EVENT_TYPES = [
  /** A candidate entered a hiring pipeline. Subject = `Candidate`. */
  'candidate.entered_pipeline',
  /** A candidate moved between pipeline stages. Subject = `Candidate`. */
  'candidate.stage_changed',
  /** A placement was contracted with the client. Subject = `Placement`. */
  'placement.contracted',
  /** A commission was earned from a placement. Subject = `Commission`. */
  'commission.earned',
  /** A placement was rescinded (clawback territory). Subject = `Placement`. */
  'placement.rescinded',
] as const;

export type AureanRecruitmentEventType = (typeof AUREAN_RECRUITMENT_EVENT_TYPES)[number];

export function isKnownAureanRecruitmentEventType(s: string): s is AureanRecruitmentEventType {
  return (AUREAN_RECRUITMENT_EVENT_TYPES as readonly string[]).includes(s);
}

export const EVENT_SUBJECT_TYPE: Record<AureanRecruitmentEventType, string> = {
  'candidate.entered_pipeline': 'Candidate',
  'candidate.stage_changed': 'Candidate',
  'placement.contracted': 'Placement',
  'commission.earned': 'Commission',
  'placement.rescinded': 'Placement',
};
