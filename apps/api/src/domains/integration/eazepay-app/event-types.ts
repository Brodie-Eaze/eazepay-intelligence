/**
 * Event-type catalogue for the EazePay App integration.
 *
 * The v1 contract is documented in
 *   docs/integration/eazepay-app-contract.md § Event-type catalogue.
 *
 * Today this file declares the *names* and the *expected subject types*.
 * Per-event payload Zod schemas land alongside each event-type as App
 * starts emitting them — we'd rather pin payloads when we can verify
 * them against real App traffic than guess shapes upfront.
 *
 * To add a new event type:
 *   1. Add the dotted name to `EAZEPAY_APP_EVENT_TYPES`.
 *   2. Add its subject-type mapping below.
 *   3. (When App emits it) write the payload Zod schema next to the name.
 *   4. Update docs/integration/eazepay-app-contract.md.
 */

/**
 * Names exactly match the publisher in
 *   EazePay App: services/webhook/src/ports/webhook-publisher.port.ts
 * plus the three "★ pending App-side emission" types from the contract.
 */
export const EAZEPAY_APP_EVENT_TYPES = [
  'application.offers_presented',
  'application.contracted',
  'application.funded',
  'application.declined',
  'loan.repayment.collected',
  'loan.repayment.failed',
  // Pending App-side wiring — see contract doc § App-side TODO checklist.
  'merchant.onboarded',
  'merchant.status_changed',
  'revenue.recorded',
] as const;

export type EazepayAppEventType = (typeof EAZEPAY_APP_EVENT_TYPES)[number];

export function isKnownEazepayAppEventType(s: string): s is EazepayAppEventType {
  return (EAZEPAY_APP_EVENT_TYPES as readonly string[]).includes(s);
}

/**
 * For each event-type, what `subject.type` are we expecting? Used during
 * drain to route to the per-entity normaliser. If subject is `null` we
 * accept and quarantine; events without a stable subject can't be merged
 * into normalised tables.
 */
export const EVENT_SUBJECT_TYPE: Record<EazepayAppEventType, string> = {
  'application.offers_presented': 'Application',
  'application.contracted': 'Application',
  'application.funded': 'Application',
  'application.declined': 'Application',
  'loan.repayment.collected': 'Loan',
  'loan.repayment.failed': 'Loan',
  'merchant.onboarded': 'Merchant',
  'merchant.status_changed': 'Merchant',
  'revenue.recorded': 'RevenueEvent',
};
