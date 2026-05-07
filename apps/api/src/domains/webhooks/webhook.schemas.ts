import { z } from 'zod';

const decimalString = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v));

// ─── BuzzPay ────────────────────────────────────────────────────────────────

export const BuzzpayApplicationWebhookSchema = z.object({
  externalApplicationId: z.string().min(1),
  partnerExternalId: z.string().min(1),
  consumer: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(4),
  }),
  enrichment: z
    .object({
      creditScore: z.number().int().min(300).max(900).optional(),
      availableCredit: decimalString.optional(),
      notedAnnualIncome: decimalString.optional(),
      bankStatementsProvided: z.boolean().optional(),
      merchantPreapproval: z.boolean().optional(),
      merchantPreapprovalAmount: decimalString.optional(),
      consumerPreapproval: z.boolean().optional(),
      consumerPreapprovalAmount: decimalString.optional(),
      fundingEstimate: decimalString.optional(),
      propensityScore: decimalString.optional(),
      openLinesOfCredit: z.number().int().min(0).optional(),
    })
    .default({}),
  status: z.enum(['PENDING', 'SUBMITTED', 'IN_REVIEW']).default('SUBMITTED'),
  submittedAt: z.string().datetime().optional(),
});
export type BuzzpayApplicationWebhook = z.infer<typeof BuzzpayApplicationWebhookSchema>;

export const BuzzpayLenderDecisionWebhookSchema = z.object({
  externalApplicationId: z.string(),
  decisionId: z.string(),
  lenderName: z.string(),
  lenderTier: z.enum(['PRIME', 'NEAR_PRIME', 'SUBPRIME', 'CARD_LINKED']),
  decision: z.enum(['APPROVED', 'DECLINED', 'PENDING']),
  decisionTimestamp: z.string().datetime(),
  approvalAmount: decimalString.optional(),
  apr: decimalString.optional(),
  term: z.number().int().optional(),
  monthlyPayment: decimalString.optional(),
  originationFee: decimalString.optional(),
});
export type BuzzpayLenderDecisionWebhook = z.infer<typeof BuzzpayLenderDecisionWebhookSchema>;

// ISO-4217 alpha-3. Optional on every revenue-bearing schema below; when
// omitted we tag the event with DEFAULT_CURRENCY at ingestion time.
const isoCurrency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);

export const BuzzpayFundingWebhookSchema = z.object({
  decisionId: z.string(),
  fundingStatus: z.enum(['FUNDED', 'FAILED']),
  fundingTimestamp: z.string().datetime(),
  fundingAmount: decimalString.optional(),
  failureReason: z.string().optional(),
  eazepayRevenue: decimalString.optional(), // BuzzPay reports our cut directly
  currency: isoCurrency.optional(),
});
export type BuzzpayFundingWebhook = z.infer<typeof BuzzpayFundingWebhookSchema>;

export const BuzzpayClawbackWebhookSchema = z.object({
  decisionId: z.string(),
  effectiveAt: z.string().datetime(),
  amount: decimalString, // positive value; we record as negative event
  reason: z.string(),
  currency: isoCurrency.optional(),
});
export type BuzzpayClawbackWebhook = z.infer<typeof BuzzpayClawbackWebhookSchema>;

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
