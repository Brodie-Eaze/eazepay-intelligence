import { z } from 'zod';

export const PartnerStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'CHURNED']);
export const PartnerTierSchema = z.enum(['BRONZE', 'SILVER', 'GOLD']);

const decimalString = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), { message: 'Invalid decimal' });

export const CreatePartnerSchema = z.object({
  externalId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  industry: z.string().min(1).max(80),
  onboardingDate: z.string().datetime().optional(),
  tier: PartnerTierSchema.default('BRONZE'),
  contractValue: decimalString.default('0'),
  buzzpayRevSharePct: decimalString.default('0'),
  pixieDataPullCost: decimalString.default('1.00'),
  pixieChargeRate: decimalString.default('3.00'),
  metadata: z.record(z.unknown()).default({}),
});
export type CreatePartnerInput = z.infer<typeof CreatePartnerSchema>;

export const UpdatePartnerSchema = CreatePartnerSchema.partial().extend({
  status: PartnerStatusSchema.optional(),
});
export type UpdatePartnerInput = z.infer<typeof UpdatePartnerSchema>;

export const ListPartnersQuerySchema = z.object({
  status: PartnerStatusSchema.optional(),
  tier: PartnerTierSchema.optional(),
  q: z.string().min(1).max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListPartnersQuery = z.infer<typeof ListPartnersQuerySchema>;

export const PartnerResponseSchema = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  name: z.string(),
  industry: z.string(),
  onboardingDate: z.string().datetime(),
  status: PartnerStatusSchema,
  tier: PartnerTierSchema,
  contractValue: z.string(),
  buzzpayRevSharePct: z.string(),
  pixieDataPullCost: z.string(),
  pixieChargeRate: z.string(),
  pixieMargin: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PartnerResponse = z.infer<typeof PartnerResponseSchema>;

/** Investor-scope projection — strips internal/identifying fields. */
export const PartnerInvestorResponseSchema = z.object({
  id: z.string(),
  label: z.string(),  // PARTNER-XXXXXXXX
  industry: z.string(),
  tier: PartnerTierSchema,
  status: PartnerStatusSchema,
  onboardingDate: z.string().datetime(),
});
export type PartnerInvestorResponse = z.infer<typeof PartnerInvestorResponseSchema>;
