/**
 * Aurean AI event envelope (GAP-103).
 *
 * Mirrors the EazePay App envelope shape so the cross-business webhook
 * processor is uniform. `data` is per-event-type; the schemas below
 * narrow the fields the drain handler actually reads.
 *
 * Contract notes:
 *   - No PII in `data`. Aurean operates on hashed identifiers; consumer
 *     contact info never leaves the source system.
 *   - `score` is a 0..1 float (probability). Boundary checked.
 *   - `revenue.accrued.amount` is a decimal-string; we never use floats
 *     in money columns.
 */
import { z } from 'zod';

export const EventSubjectSchema = z
  .object({
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(128),
  })
  .strict()
  .nullable();

export const AureanAiEventEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    eventType: z.string().min(1).max(128),
    subject: EventSubjectSchema,
    data: z.record(z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AureanAiEventEnvelope = z.infer<typeof AureanAiEventEnvelopeSchema>;

// ─── Per-event-type payload schemas ─────────────────────────────────────────

export const InferenceCompletedSchema = z
  .object({
    runId: z.string().min(1).max(128),
    modelVersion: z.string().min(1).max(64),
    /** Inference run latency in milliseconds; for SLA dashboards. */
    latencyMs: z.number().int().nonnegative(),
    /** Number of records scored in this run. */
    recordCount: z.number().int().nonnegative(),
    completedAt: z.string().datetime(),
  })
  .strict();

export const ScorePublishedSchema = z
  .object({
    scoreId: z.string().min(1).max(128),
    /** Consumer identifier as a deterministic hash (no plaintext PII). */
    consumerEmailHashHex: z.string().regex(/^[a-f0-9]{64}$/),
    modelVersion: z.string().min(1).max(64),
    /** Probability in [0, 1]. */
    riskScore: z.number().min(0).max(1),
    /** Optional A/B label for downstream analytics. */
    cohort: z.string().min(1).max(64).optional(),
    publishedAt: z.string().datetime(),
  })
  .strict();

export const RevenueAccruedSchema = z
  .object({
    externalEventId: z.string().min(1).max(128),
    partnerExternalId: z.string().min(1).max(128),
    /** Decimal string — never a JSON number for money. */
    amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
    currency: z.string().length(3).optional(),
    /** Stream tag matching Intelligence's RevenueStream enum. */
    stream: z.literal('AUREAN_AI'),
    eventType: z.enum(['ACCRUAL', 'COMMISSION', 'REVERSAL']),
    effectiveAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const ModelDeployedSchema = z
  .object({
    modelVersion: z.string().min(1).max(64),
    deployedAt: z.string().datetime(),
    /** Optional rollback target for audit (`null` for the first deploy). */
    previousModelVersion: z.string().min(1).max(64).nullable(),
    /** Human-readable change summary for the audit log. */
    changeSummary: z.string().min(1).max(2000),
  })
  .strict();
