/**
 * HighSale business-event envelope (GAP-105).
 *
 * Aligned with the other business webhooks (same envelope shape). No PII
 * in `data` — consumer identity is referenced by deterministic hashes,
 * not by name/email.
 */
import { z } from 'zod';

export const EventSubjectSchema = z
  .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) })
  .strict()
  .nullable();

export const HighSaleBusinessEventEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    eventType: z.string().min(1).max(128),
    subject: EventSubjectSchema,
    data: z.record(z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export type HighSaleBusinessEventEnvelope = z.infer<typeof HighSaleBusinessEventEnvelopeSchema>;

export const InquirySubmittedSchema = z
  .object({
    inquiryId: z.string().min(1).max(128),
    /** sha256(lowercase(email)) hex. */
    consumerEmailHashHex: z.string().regex(/^[a-f0-9]{64}$/),
    vertical: z.enum(['AUTO', 'PROPERTY', 'CONSUMER', 'COMMERCIAL']),
    submittedAt: z.string().datetime(),
  })
  .strict();

export const RiskBandAssignedSchema = z
  .object({
    inquiryId: z.string().min(1).max(128),
    riskBand: z.enum(['LOW', 'MED', 'HIGH']),
    confidence: z.number().min(0).max(1),
    assignedAt: z.string().datetime(),
  })
  .strict();

export const SnapshotGeneratedSchema = z
  .object({
    highsaleTransactionId: z.string().min(1).max(128),
    inquiryId: z.string().min(1).max(128),
    vertical: z.enum(['AUTO', 'PROPERTY', 'CONSUMER', 'COMMERCIAL']),
    generatedAt: z.string().datetime(),
  })
  .strict();

export const RevenueRecordedSchema = z
  .object({
    externalEventId: z.string().min(1).max(128),
    partnerExternalId: z.string().min(1).max(128),
    amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
    currency: z.string().length(3).optional(),
    eventType: z.enum(['ACCRUAL', 'COMMISSION', 'REVERSAL']),
    effectiveAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
