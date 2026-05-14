/**
 * Wire envelope for events arriving from EazePay App.
 *
 * Locked against:
 *   /Users/Brodie/EazePay App/services/webhook/src/internal/dispatcher.service.ts
 *   line 90–97 (the JSON.stringify body shape).
 *
 * Any divergence between this schema and what App actually POSTs is an
 * integration P0 — break it loud (Zod rejection → 400) rather than
 * accept malformed data.
 *
 * See: docs/integration/eazepay-app-contract.md
 */
import { z } from 'zod';

/**
 * Subject anchor for the event. App publishes (Application, applicationId)
 * for application.* events and (Loan, loanId) for loan.* events.
 *
 * `null` is permitted because the App-side `WebhookPublishInput.subject`
 * is `string | null` — events without a stable subject (rare) are valid.
 */
export const EventSubjectSchema = z
  .object({
    type: z.string().min(1).max(64),
    id: z.string().uuid(),
  })
  .strict()
  .nullable();

export type EventSubject = z.infer<typeof EventSubjectSchema>;

/**
 * Outer envelope. The shape is owned by App; Intelligence accepts it
 * unmodified. `data` is intentionally loose at this layer — per-eventType
 * payload schemas (event-types.ts) refine it during drain.
 */
export const EazepayAppEventEnvelopeSchema = z
  .object({
    /** WebhookDelivery row uuid (App-side). Carried for traceability. */
    id: z.string().uuid(),
    /** Stable canonical event id. Dedupe key alongside Idempotency-Key. */
    eventId: z.string().uuid(),
    /** Dotted name — see event-types.ts for the union. */
    eventType: z.string().min(1).max(128),
    subject: EventSubjectSchema,
    /** Reference-only payload. App contract: no money, no PII inline. */
    data: z.record(z.unknown()),
    /** App-side emission time, ISO-8601. */
    createdAt: z.string().datetime(),
  })
  .strict();

export type EazepayAppEventEnvelope = z.infer<typeof EazepayAppEventEnvelopeSchema>;
