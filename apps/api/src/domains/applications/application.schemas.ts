import { z } from 'zod';

export const ApplicationStatusSchema = z.enum([
  'PENDING',
  'SUBMITTED',
  'IN_REVIEW',
  // GAP-102: OFFERED + CONTRACTED were added to the Prisma enum by Phase 1
  // (migration 20260515130000) so the EazePay App drain handlers can write
  // the correct status transition when commission accrual fires.
  // QUARANTINE is for brand=direct events with no resolved org.
  'OFFERED',
  'APPROVED',
  'CONTRACTED',
  'DECLINED',
  'FUNDED',
  'QUARANTINE',
]);

export const ListApplicationsQuerySchema = z.object({
  partnerId: z.string().uuid().optional(),
  status: ApplicationStatusSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListApplicationsQuery = z.infer<typeof ListApplicationsQuerySchema>;

/** Standard scope: PII fields are MASKED (e.g. b***@example.com) for VIEWER, full for OPERATOR. */
export const ApplicationResponseSchema = z.object({
  id: z.string().uuid(),
  partnerId: z.string().uuid(),
  externalApplicationId: z.string(),
  consumerNameMasked: z.string(),
  consumerEmailMasked: z.string(),
  consumerPhoneMasked: z.string(),
  creditScore: z.number().int().nullable(),
  availableCredit: z.string().nullable(),
  notedAnnualIncome: z.string().nullable(),
  bankStatementsProvided: z.boolean(),
  merchantPreapproval: z.boolean(),
  merchantPreapprovalAmount: z.string().nullable(),
  consumerPreapproval: z.boolean(),
  consumerPreapprovalAmount: z.string().nullable(),
  fundingEstimate: z.string().nullable(),
  propensityScore: z.string().nullable(),
  openLinesOfCredit: z.number().int().nullable(),
  status: ApplicationStatusSchema,
  submittedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ApplicationResponse = z.infer<typeof ApplicationResponseSchema>;

export const ApplicationPiiResponseSchema = z.object({
  id: z.string().uuid(),
  consumerName: z.string(),
  consumerEmail: z.string(),
  consumerPhone: z.string(),
});
