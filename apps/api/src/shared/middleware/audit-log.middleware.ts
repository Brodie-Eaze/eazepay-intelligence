import { v7 as uuidv7 } from 'uuid';
import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrisma } from '../../config/database.js';

/**
 * Append-only audit writer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR: audit-log atomicity (SOC2 CC6-021 / CC7.3, GDPR Art. 30, PCI 10.2/10.3)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Audit writes are **atomic with the mutation they describe** when the helper
 * is called inside a `prisma.$transaction(async (tx) => …)` and the tx client
 * is passed via the `tx` argument:
 *
 *     await prisma.$transaction(async (tx) => {
 *       await tx.user.update({ where: { id }, data: { role: 'ADMIN' } });
 *       await writeAuditLog({ req, tx, action: 'USER_UPDATED', … });
 *     });
 *
 * Either both rows commit or neither does. Orphan writes — a mutation that
 * lands without its audit row, or an audit row referencing a mutation that
 * rolled back — are **impossible** by construction. This is the first line
 * of defence behind the role-level REVOKE on `audit_logs` (UPDATE / DELETE
 * are revoked at the DB role; the writer role can only INSERT).
 *
 * Auditor-readable claim: every state change on regulated data that is
 * routed through this helper produces exactly one corresponding `audit_logs`
 * row, or no mutation occurred at all. Drift between business state and the
 * audit trail cannot happen without a violation of the transaction itself.
 *
 * Without `tx`, the helper falls back to the global Prisma client. That mode
 * is reserved for:
 *   - Best-effort failure recording (e.g. RTBF_FAILED, fired after the
 *     business tx has already rolled back — we still want a record).
 *   - System / lifecycle events with no enclosing mutation tx (cron jobs,
 *     scheduled FX ingestion, worker lifecycle).
 *   - Auth audit rows (USER_LOGIN, USER_LOGIN_FAILED) where the "mutation"
 *     is a session-issuance side effect we want recorded even if the cookie
 *     write later fails.
 *
 * Callers MUST NOT call `update` or `delete` on `audit_logs`. The schema
 * comment + DB role both enforce this; the type only exposes `auditLog`.
 *
 * Phase 7 (SF-009) introduced the `tx` argument. SOC2 CC6-021 (May 2026)
 * required the highest-risk mutations to actually pass it; this docstring
 * is the design record for that effort.
 */
type AuditTxClient = Pick<PrismaClient, 'auditLog'> | Prisma.TransactionClient;

export async function writeAuditLog(args: {
  req?: FastifyRequest;
  userId?: string | null;
  /**
   * Org the audit event took place within. Nullable for platform-level
   * system events (org creation, FX rate update, system lifecycle jobs).
   *
   * Resolution order (first non-null wins):
   *   1. Explicit `orgId` argument (used by workers, e.g. RTBF processing
   *      where orgId comes from the request row, not the request context).
   *   2. `req.auth.orgId` populated by the tenant-resolution middleware
   *      (lands in Phase 1.3).
   *   3. null — recorded as a platform-level event, visible only to
   *      platform-staff cross-tenant audit views.
   */
  orgId?: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Phase 7 (SF-009): when supplied, the audit row is written via this
   * transaction client so the audit + the mutation rollback together.
   * Omit for fire-and-forget audit writes (system events, retried jobs).
   */
  tx?: AuditTxClient;
}): Promise<void> {
  const ipAddress = args.req?.ip ?? null;
  const ua = args.req?.headers['user-agent'];
  const userAgent = (Array.isArray(ua) ? ua[0] : ua) ?? null;
  const client = args.tx ?? getPrisma();
  await client.auditLog.create({
    data: {
      id: uuidv7(),
      userId: args.userId ?? args.req?.auth?.userId ?? null,
      orgId: args.orgId ?? args.req?.auth?.orgId ?? null,
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
  | 'USER_MFA_FAILED'
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DELETED'
  | 'USER_INVITED'
  | 'USER_INVITATION_ACCEPTED'
  | 'USER_INVITATION_REVOKED'
  | 'USER_LOGIN_OAUTH'
  | 'USER_SESSION_REVOKED'
  | 'PLATFORM_CROSS_TENANT_ACCESS'
  | 'PLATFORM_ORG_CREATED'
  | 'PLATFORM_ORG_UPDATED'
  | 'PLATFORM_ORG_DELETED'
  | 'PLATFORM_DEK_ROTATED'
  | 'PLATFORM_ORG_CRYPTOSHRED'
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
  | 'INGESTION_REQUEST'
  | 'INGESTION_REJECTED'
  | 'ALERT_FIRED'
  | 'ALERT_RESOLVED'
  | 'RTBF_SUBMITTED'
  | 'RTBF_PROCESSED'
  | 'RTBF_FAILED'
  | 'LIFECYCLE_PURGE'
  | 'FX_RATE_INGESTED'
  | 'PORTFOLIO_BUSINESS_CREATED'
  | 'PORTFOLIO_BUSINESS_UPDATED'
  | 'PORTFOLIO_VERTICAL_CREATED'
  | 'CREDIT_SNAPSHOT_RECEIVED'
  | 'PROTECTED_CLASS_READ'
  | 'DATA_EXPORTED';
