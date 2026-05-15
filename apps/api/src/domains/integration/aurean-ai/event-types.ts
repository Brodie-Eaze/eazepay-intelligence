/**
 * Event-type catalogue for the Aurean AI integration (GAP-103).
 *
 * Aurean AI is the inference + scoring platform that feeds risk signals
 * into EazePay's lender-tier waterfall. It runs in its own infra and
 * emits webhooks to Intelligence as inference results are produced.
 *
 * Today's transport is the PAT-driven /ingestion/* generic pipe; this
 * module reserves the typed shape so when Aurean cuts over to native
 * HMAC-signed webhooks (POST /integration/aurean-ai/events), the drain
 * handler already knows the contract.
 *
 * To add a new event type:
 *   1. Add the dotted name to `AUREAN_AI_EVENT_TYPES`.
 *   2. Add its subject-type to `EVENT_SUBJECT_TYPE`.
 *   3. Add the per-event payload Zod schema below.
 *   4. Wire the drain handler in aurean-ai.service.ts (once it lands).
 */

export const AUREAN_AI_EVENT_TYPES = [
  /** A new inference job ran. Subject = `InferenceRun`. */
  'inference.completed',
  /** An inference's score was published to a partner. Subject = `Score`. */
  'score.published',
  /** Revenue accrual against an inference (per-call / per-1000 / committed). */
  'revenue.accrued',
  /** Model deployed to the inference cluster. Subject = `ModelVersion`. */
  'model.deployed',
] as const;

export type AureanAiEventType = (typeof AUREAN_AI_EVENT_TYPES)[number];

export function isKnownAureanAiEventType(s: string): s is AureanAiEventType {
  return (AUREAN_AI_EVENT_TYPES as readonly string[]).includes(s);
}

export const EVENT_SUBJECT_TYPE: Record<AureanAiEventType, string> = {
  'inference.completed': 'InferenceRun',
  'score.published': 'Score',
  'revenue.accrued': 'RevenueEvent',
  'model.deployed': 'ModelVersion',
};
