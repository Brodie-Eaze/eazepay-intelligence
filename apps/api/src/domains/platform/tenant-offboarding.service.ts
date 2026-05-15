/**
 * Tenant offboarding service (Phase H).
 *
 * GDPR Art. 30 (records of processing activities) + Art. 17 (right to
 * erasure when applied to an entire customer) require a defined process
 * for what happens when a tenant terminates. The cryptoshred endpoint
 * already destroys the per-tenant DEK; this service wraps that into a
 * complete "tenant offboarding" workflow:
 *
 *   1. **Soft-delete** the Organization row (deletedAt = now). Stops
 *      new logins, new webhook routing, new memberships.
 *   2. **Audit-archive** all the tenant's audit_log + revenue_event +
 *      lender_decision rows to a JSON snapshot stored in the export
 *      storage backend (S3 in prod). The snapshot is the regulator-
 *      visible evidence trail; the live rows can then be cryptoshredded
 *      without losing compliance evidence.
 *   3. **Cryptoshred** the tenant DEK (existing `cryptoshredOrg`).
 *      Applications/credit_enrichments rows become permanently
 *      unrecoverable.
 *   4. **Schedule final retention pass**: outbox rows get an immediate
 *      DELETE (no retention period — tenant is gone), webhook_events
 *      get marked QUARANTINED so the drain worker stops touching them,
 *      lender_reporting_events follow the standard retention policy.
 *   5. **Write the offboarding audit row** with the full event timeline
 *      so any future regulator inquiry has the paper trail.
 *
 * SOC 2 mapping:
 *   - CC6.5  (information deletion per policy)
 *   - CC7.4  (incident handling — this is a planned destruction event)
 *   - A1.2   (availability of the audit evidence post-offboard)
 *
 * Operator usage: call from POST /platform/orgs/:id/offboard with the
 * SUPER role + MFA step-up + explicit slug confirmation header. The
 * route exposing this is intentionally separate from the bare
 * cryptoshred endpoint — offboarding is a deliberate workflow, not an
 * emergency action.
 */
import type { PrismaClient } from '@prisma/client';
import { getLogger } from '../../config/logger.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { cryptoshredOrg } from '../../shared/kms/tenant-dek.js';
import { getExportStorage } from '../../shared/storage/index.js';

export interface OffboardingSummary {
  orgId: string;
  orgSlug: string;
  archivedAt: string;
  archive: { locator: string; size: number };
  cryptoshredded: boolean;
  outboxRowsDeleted: number;
  webhookEventsQuarantined: number;
}

export class TenantOffboardingService {
  constructor(private readonly prisma: PrismaClient) {}

  async offboard(args: {
    orgId: string;
    confirmSlug: string;
    operatorUserId: string;
  }): Promise<OffboardingSummary> {
    const log = getLogger();
    const org = await this.prisma.organization.findFirst({
      where: { id: args.orgId },
    });
    if (!org) throw new Error('tenant-offboarding: org not found');
    if (org.deletedAt) throw new Error('tenant-offboarding: org already offboarded');
    if (org.slug !== args.confirmSlug) {
      throw new Error('tenant-offboarding: slug confirmation mismatch');
    }

    // ─── 1. Soft-delete ─────────────────────────────────────────────────
    await this.prisma.organization.update({
      where: { id: org.id },
      data: { deletedAt: new Date() },
    });
    log.info({ orgId: org.id, orgSlug: org.slug }, 'tenant_offboarding.soft_delete');

    // ─── 2. Audit-archive ───────────────────────────────────────────────
    // Snapshot the audit + financial-evidence rows BEFORE cryptoshred.
    // The archive lives in the export-storage backend; under S3 it has
    // bucket-level retention. Under local-disk it's preserved for the
    // operator's manual archive.
    const [auditLogs, revenueEvents, lenderDecisions, lenderReportingEvents] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { orgId: org.id } }),
      this.prisma.revenueEvent.findMany({ where: { orgId: org.id } }),
      this.prisma.lenderDecision.findMany({ where: { orgId: org.id } }),
      this.prisma.lenderReportingEvent.findMany({ where: { orgId: org.id } }),
    ]);
    const archivePayload = {
      orgId: org.id,
      orgSlug: org.slug,
      archivedAt: new Date().toISOString(),
      operatorUserId: args.operatorUserId,
      counts: {
        auditLogs: auditLogs.length,
        revenueEvents: revenueEvents.length,
        lenderDecisions: lenderDecisions.length,
        lenderReportingEvents: lenderReportingEvents.length,
      },
      auditLogs,
      revenueEvents,
      lenderDecisions,
      lenderReportingEvents,
    };
    const body = JSON.stringify(archivePayload, null, 2);
    const archive = await getExportStorage().write({
      exportId: `offboard-${org.id}`,
      extension: 'json',
      body,
      contentType: 'application/json',
    });

    // ─── 3. Cryptoshred ─────────────────────────────────────────────────
    // Destroy the per-org DEK. Applications + credit_enrichments
    // ciphertext is now permanently unrecoverable.
    await cryptoshredOrg(this.prisma, org.id);

    // ─── 4. Final retention pass ────────────────────────────────────────
    const outboxDeleted = await this.prisma.outboxEvent.deleteMany({
      where: { orgId: org.id },
    });
    const webhookQuarantined = await this.prisma.webhookEvent.updateMany({
      where: { orgId: org.id, status: { in: ['RECEIVED', 'PROCESSED', 'FAILED'] } },
      data: { status: 'QUARANTINED', processingError: 'tenant.offboarded' },
    });

    // ─── 5. Final audit row ─────────────────────────────────────────────
    await writeAuditLog({
      orgId: org.id,
      userId: args.operatorUserId,
      action: 'PLATFORM_ORG_CRYPTOSHRED',
      resourceType: 'organization',
      resourceId: org.id,
      metadata: {
        slug: org.slug,
        archive: archive.locator,
        outboxDeleted: outboxDeleted.count,
        webhookQuarantined: webhookQuarantined.count,
        offboardingSurface: 'tenant-offboarding.service',
      },
    });

    return {
      orgId: org.id,
      orgSlug: org.slug,
      archivedAt: archivePayload.archivedAt,
      archive,
      cryptoshredded: true,
      outboxRowsDeleted: outboxDeleted.count,
      webhookEventsQuarantined: webhookQuarantined.count,
    };
  }
}
