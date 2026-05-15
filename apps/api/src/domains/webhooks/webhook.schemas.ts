import { z } from 'zod';

const decimalString = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v));

// ISO-4217 alpha-3. Optional on every revenue-bearing schema below; when
// omitted we tag the event with DEFAULT_CURRENCY at ingestion time.
const isoCurrency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);

// ─── Pixie ──────────────────────────────────────────────────────────────────

export const PixieUsageWebhookSchema = z.object({
  date: z.string().datetime(),
  collectivePulls: z.number().int().nonnegative(),
  partners: z.array(
    z.object({
      partnerExternalId: z.string(),
      pulls: z.number().int().nonnegative(),
    }),
  ),
});
export type PixieUsageWebhook = z.infer<typeof PixieUsageWebhookSchema>;

// ─── MiCamp ─────────────────────────────────────────────────────────────────

export const MicampProcessingWebhookSchema = z.object({
  partnerExternalId: z.string(),
  effectiveAt: z.string().datetime(),
  grossProcessingFee: decimalString,
  txnCount: z.number().int().nonnegative(),
  currency: isoCurrency.optional(),
});
export type MicampProcessingWebhook = z.infer<typeof MicampProcessingWebhookSchema>;

export const MicampReversalWebhookSchema = z.object({
  partnerExternalId: z.string(),
  effectiveAt: z.string().datetime(),
  reversalAmount: decimalString, // positive; recorded as negative event
  reason: z.string(),
  currency: isoCurrency.optional(),
});
export type MicampReversalWebhook = z.infer<typeof MicampReversalWebhookSchema>;
