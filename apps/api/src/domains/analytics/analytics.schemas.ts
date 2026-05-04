import { z } from 'zod';

export const AnalyticsRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AnalyticsRangeQuery = z.infer<typeof AnalyticsRangeQuerySchema>;

export const AnalyticsRevenueQuerySchema = AnalyticsRangeQuerySchema.extend({
  bucket: z.enum(['day', 'week', 'month']).default('day'),
});

export const OverviewResponseSchema = z.object({
  totalRevenue: z.string(),
  approvalRate: z.string(),
  fundingRate: z.string(),
  activePartnerCount: z.number().int(),
  pixiePullsLast24h: z.number().int(),
  momRevenueDelta: z.string(),
  windowFrom: z.string().datetime(),
  windowTo: z.string().datetime(),
  generatedAt: z.string().datetime(),
});
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;
