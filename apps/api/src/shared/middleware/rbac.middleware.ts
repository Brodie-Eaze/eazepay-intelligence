import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { UserRole } from '@prisma/client';
import { errors } from '../errors/app-error.js';

/**
 * Require any of the listed roles. Investor scope is enforced separately —
 * this guards on underlying ROLE, not session scope.
 */
export function requireRole(...allowed: UserRole[]): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    const auth = req.auth;
    if (!auth) throw errors.unauthorized();
    if (!allowed.includes(auth.role)) {
      throw errors.forbidden(`Requires one of: ${allowed.join(', ')}`);
    }
  };
}

/**
 * Block this route entirely when the active session scope is `investor`.
 * Use for routes that must never appear in an investor demo (PII reveal, audit log,
 * clawbacks, user admin).
 */
export const denyInvestorScope: preHandlerHookHandler = async (req) => {
  const auth = req.auth;
  if (!auth) throw errors.unauthorized();
  if (auth.scope === 'investor') {
    throw errors.forbidden('Endpoint not available in investor scope');
  }
};

/** Compose multiple preHandlers in order. */
export function compose(...handlers: preHandlerHookHandler[]): preHandlerHookHandler {
  return async (req, reply) => {
    for (const h of handlers) {
      await h.call(reply.server, req, reply, () => undefined);
      if (reply.sent) return;
    }
  };
}
