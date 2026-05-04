import type { UserRole } from '@prisma/client';
import type { AuthScope } from './auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthContext {
  userId: string;
  email: string;
  role: UserRole;
  scope: AuthScope;
  jti: string;
}
