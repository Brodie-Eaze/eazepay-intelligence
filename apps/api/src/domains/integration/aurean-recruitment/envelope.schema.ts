/**
 * Aurean Recruitment event envelope (GAP-104).
 *
 * Same shape contract as the other business webhooks. No PII in `data` —
 * candidates are referenced by ATS id, not by name/email.
 */
import { z } from 'zod';

export const EventSubjectSchema = z
  .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) })
  .strict()
  .nullable();

export const AureanRecruitmentEventEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    eventType: z.string().min(1).max(128),
    subject: EventSubjectSchema,
    data: z.record(z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AureanRecruitmentEventEnvelope = z.infer<typeof AureanRecruitmentEventEnvelopeSchema>;

export const CandidateEnteredPipelineSchema = z
  .object({
    candidateExternalId: z.string().min(1).max(128),
    pipelineId: z.string().min(1).max(128),
    sourceChannel: z.string().min(1).max(64),
    enteredAt: z.string().datetime(),
  })
  .strict();

export const CandidateStageChangedSchema = z
  .object({
    candidateExternalId: z.string().min(1).max(128),
    pipelineId: z.string().min(1).max(128),
    fromStage: z.string().min(1).max(64),
    toStage: z.string().min(1).max(64),
    changedAt: z.string().datetime(),
  })
  .strict();

export const PlacementContractedSchema = z
  .object({
    placementId: z.string().min(1).max(128),
    candidateExternalId: z.string().min(1).max(128),
    partnerExternalId: z.string().min(1).max(128),
    /** Annualised placement value (decimal-string). */
    annualSalary: z.string().regex(/^\d+(\.\d{1,2})?$/),
    currency: z.string().length(3).optional(),
    contractedAt: z.string().datetime(),
  })
  .strict();

export const CommissionEarnedSchema = z
  .object({
    externalEventId: z.string().min(1).max(128),
    placementId: z.string().min(1).max(128),
    partnerExternalId: z.string().min(1).max(128),
    amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
    currency: z.string().length(3).optional(),
    effectiveAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const PlacementRescindedSchema = z
  .object({
    externalEventId: z.string().min(1).max(128),
    placementId: z.string().min(1).max(128),
    partnerExternalId: z.string().min(1).max(128),
    /** Positive clawback amount; the drain writes the negation onto the ledger. */
    clawbackAmount: z.string().regex(/^\d+(\.\d{1,4})?$/),
    currency: z.string().length(3).optional(),
    rescindedAt: z.string().datetime(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();
