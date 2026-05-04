import { z } from 'zod';

export const LoginRequestSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(256),
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({}).strict();

export const ScopeRequestSchema = z.object({
  scope: z.enum(['standard', 'investor']),
});
export type ScopeRequest = z.infer<typeof ScopeRequestSchema>;

export const UserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['ADMIN', 'OPERATOR', 'INVESTOR', 'VIEWER']),
  scope: z.enum(['standard', 'investor']),
  mfaEnabled: z.boolean(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const SessionResponseSchema = z.object({
  user: UserResponseSchema,
  csrfToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const WsTicketResponseSchema = z.object({
  ticket: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
