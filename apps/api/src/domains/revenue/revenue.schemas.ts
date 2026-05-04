import { z } from 'zod';

export const RevenueStreamSchema = z.enum(['BUZZPAY', 'PIXIE', 'MICAMP']);
export const RevenueEventTypeSchema = z.enum([
  'ACCRUAL', 'FUNDING', 'CLAWBACK', 'REVERSAL', 'PIXIE_MARGIN', 'PROCESSING_FEE', 'ADJUSTMENT',
]);

export const RevenueLedgerQuerySchema = z.object({
  partnerId: z.string().uuid().optional(),
  stream: RevenueStreamSchema.optional(),
  eventType: RevenueEventTypeSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RevenueLedgerQuery = z.infer<typeof RevenueLedgerQuerySchema>;

export const RevenueByStreamQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  bucket: z.enum(['day', 'week', 'month']).default('day'),
});
export type RevenueByStreamQuery = z.infer<typeof RevenueByStreamQuerySchema>;
