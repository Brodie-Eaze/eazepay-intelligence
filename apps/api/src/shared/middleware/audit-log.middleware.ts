import { v7 as uuidv7 } from 'uuid';
import type { FastifyRequest } from 'fastify';
import { getPrisma } from '../../config/database.js';

/**
 * Append-only audit writer. Always wraps in the same DB connection — callers
 * should pass a Prisma transaction client when in a tx, otherwise the global one.
 *
 * The role-level REVOKE on `audit_logs` is the second line of defence; this is the
 * first. Callers MUST NOT update or delete rows.
 */
export async function writeAuditLog(args: {
  req?: FastifyRequest;
  userId?: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const ipAddress = args.req?.ip ?? null;
  const ua = args.req?.headers['user-agent'];
  const userAgent = (Array.isArray(ua) ? ua[0] : ua) ?? null;
  await getPrisma().auditLog.create({
    data: {
      id: uuidv7(),
      userId: args.userId ?? args.req?.auth?.userId ?? null,
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId ?? null,
      metadata: (args.metadata ?? {}) as object,
      ipAddress,
      userAgent,
    },
  });
}

export type AuditAction =
  | 'USER_LOGIN'
  | 'USER_LOGIN_FAILED'
  | 'USER_LOGOUT'
  | 'USER_REFRESHED'
  | 'USER_SCOPE_CHANGED'
  | 'USER_MFA_ENABLED'
  | 'USER_MFA_DISABLED'
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DELETED'
  | 'PARTNER_CREATED'
  | 'PARTNER_UPDATED'
  | 'PARTNER_DELETED'
  | 'PII_ACCESSED'
  | 'WEBHOOK_RECEIVED'
  | 'WEBHOOK_PROCESSED'
  | 'WEBHOOK_FAILED'
  | 'WEBHOOK_REPLAYED'
  | 'REVENUE_EVENT_RECORDED'
  | 'WS_TICKET_ISSUED'
  | 'WS_CONNECTED'
  | 'WS_DISCONNECTED'
  | 'PORTFOLIO_FINANCIALS_ACCESSED'
  | 'PORTFOLIO_DATA_INGESTED'
  | 'PORTFOLIO_BUSINESS_CREATED'
  | 'PORTFOLIO_BUSINESS_UPDATED'
  | 'PORTFOLIO_VERTICAL_CREATED';
