import { z } from 'zod';

export const PixieUsageQuerySchema = z.object({
  partnerId: z.string().uuid().optional(),
  period: z.enum(['DAILY', 'MONTHLY', 'YEARLY']).default('DAILY'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type PixieUsageQuery = z.infer<typeof PixieUsageQuerySchema>;
