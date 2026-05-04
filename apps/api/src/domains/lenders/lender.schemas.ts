import { z } from 'zod';

export const LenderTierSchema = z.enum(['PRIME', 'NEAR_PRIME', 'SUBPRIME', 'CARD_LINKED']);

export const LenderRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  tier: LenderTierSchema.optional(),
});
export type LenderRangeQuery = z.infer<typeof LenderRangeQuerySchema>;

export const WaterfallRowSchema = z.object({
  lenderName: z.string(),
  lenderTier: LenderTierSchema,
  submitted: z.number().int(),
  approved: z.number().int(),
  declined: z.number().int(),
  funded: z.number().int(),
  approvalRate: z.string(),
  fundingRate: z.string(),
  avgApr: z.string().nullable(),
  totalFunded: z.string(),
});
export type WaterfallRow = z.infer<typeof WaterfallRowSchema>;
