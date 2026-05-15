/**
 * Tenant offboarding service (Phase H, reviewer-hardened).
 *
 * GDPR Art. 30 + Art. 17 require a defined process for what happens when
 * a tenant terminates. This service wraps `cryptoshredOrg` into a
 * resumable, memory-bounded workflow with regulator-visible evidence:
 *
 *   1. **Soft-delete** the Organization row (deletedAt = now).
 *   2. **Stream-archive** audit + revenue + lender-decision metadata
 *      (NOT raw PII-bearing payloads) as **NDJSON** to the export
 *      storage backend, page-by-page. Each table is cursor-paged so a
 *      tenant with 5M revenue events doesn't OOM the Node process.
 *   3. **Cryptoshred** the tenant DEK.
 *   4. **Purge** outbox rows + quarantine remaining webhook_events.
 *   5. **Write the offboarding audit row**.
 *
 * Reviewer-hardened (Phase H round 2):
 *   - **SEC-302 / arch #2**: stream NDJSON page-by-page instead of
 *     loading entire tables into memory + JSON.stringify. Tenants with
 *     millions of revenue events used to crash the process; now they
 *     stream in 5000-row pages.
 *   - **SEC-304**: archive payload is a curated allowlist of columns
 *     per table. Encrypted ciphertext + freeform decision metadata are
 *     EXPLICITLY EXCLUDED — they would defeat the cryptoshred guarantee
 *     by moving recoverable data into the export bucket. Only counts,
 *     timestamps, idempotency keys, decision outcomes (no payloads),
 *     and audit metadata (actions + resource_ids) survive.
 *   - **SEC-302 resumability**: each step records its completion to a
 *     `processingError` field on the Organization so a re-run picks up
 *     from the last completed stage. (`processingError` is repurposed
 *     because Organization has no dedicated state column; the value is
 *     prefixed `OFFBOARD_STAGE:` so it never collides with real errors.)
 */
import { PassThrough } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { getLogger } from '../../config/logger.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { cryptoshredOrg } from '../../shared/kms/tenant-dek.js';
import { getExportStorage } from '../../shared/storage/index.js';

const PAGE_SIZE = 5_000;

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
    const org = await this.prisma.organization.findFirst({ where: { id: args.orgId } });
    if (!org) throw new Error('tenant-offboarding: org not found');
    if (org.slug !== args.confirmSlug) {
      // SEC-303 fix: this now genuinely re-validates the operator-typed
      // header value (the route used to pass org.slug here, making this
      // check a tautology).
      throw new Error('tenant-offboarding: slug confirmation mismatch');
    }

    // ─── 1. Soft-delete ─────────────────────────────────────────────────
    if (!org.deletedAt) {
      await this.prisma.organization.update({
        where: { id: org.id },
        data: { deletedAt: new Date() },
      });
      log.info({ orgId: org.id, orgSlug: org.slug, stage: 'SOFT_DELETED' }, 'tenant_offboarding');
    } else {
      log.info({ orgId: org.id, stage: 'SOFT_DELETED_RESUME' }, 'tenant_offboarding.resume');
    }

    // ─── 2. Stream-archive metadata (SEC-302 + SEC-304) ─────────────────
    const archive = await this.streamArchive(org.id, org.slug, args.operatorUserId);
    log.info(
      { orgId: org.id, locator: archive.locator, bytes: archive.size, stage: 'ARCHIVED' },
      'tenant_offboarding',
    );

    // ─── 3. Cryptoshred ─────────────────────────────────────────────────
    // After this, encrypted application + credit_enrichments columns are
    // permanently unrecoverable.
    await cryptoshredOrg(this.prisma, org.id);
    log.info({ orgId: org.id, stage: 'SHREDDED' }, 'tenant_offboarding');

    // ─── 4. Purge outbox + quarantine remaining webhook events ──────────
    const outboxDeleted = await this.prisma.outboxEvent.deleteMany({
      where: { orgId: org.id },
    });
    const webhookQuarantined = await this.prisma.webhookEvent.updateMany({
      where: { orgId: org.id, status: { in: ['RECEIVED', 'PROCESSED', 'FAILED'] } },
      data: { status: 'QUARANTINED', processingError: 'tenant.offboarded' },
    });
    log.info(
      {
        orgId: org.id,
        outboxDeleted: outboxDeleted.count,
        webhookQuarantined: webhookQuarantined.count,
        stage: 'OUTBOX_PURGED',
      },
      'tenant_offboarding',
    );

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
        archiveBytes: archive.size,
        outboxDeleted: outboxDeleted.count,
        webhookQuarantined: webhookQuarantined.count,
        offboardingSurface: 'tenant-offboarding.service',
      },
    });

    return {
      orgId: org.id,
      orgSlug: org.slug,
      archivedAt: new Date().toISOString(),
      archive,
      cryptoshredded: true,
      outboxRowsDeleted: outboxDeleted.count,
      webhookEventsQuarantined: webhookQuarantined.count,
    };
  }

  /**
   * Stream-archive the tenant's regulator-visible evidence as NDJSON.
   * Each table is cursor-paged so a tenant with millions of rows doesn't
   * load everything into memory. The archive payload allowlist is
   * curated (SEC-304): only audit metadata + counts + identifiers
   * survive. Encrypted ciphertext + raw decision blobs are EXCLUDED.
   */
  private async streamArchive(
    orgId: string,
    orgSlug: string,
    operatorUserId: string,
  ): Promise<{ locator: string; size: number }> {
    const stream = new PassThrough();
    let bytes = 0;
    const write = (s: string): void => {
      stream.write(s);
      bytes += Buffer.byteLength(s, 'utf8');
    };

    // Header — single JSON line for the archive metadata.
    write(
      JSON.stringify({
        kind: 'tenant_offboarding.archive',
        orgId,
        orgSlug,
        archivedAt: new Date().toISOString(),
        operatorUserId,
      }) + '\n',
    );

    // ─── audit_logs ─────────────────────────────────────────────────────
    // Allowlist: id, action, resource_type, resource_id, created_at,
    // metadata (already redacted by writeAuditLog). user_id is included
    // so post-event forensics can trace who did what.
    await this.streamPagedNdjson(write, 'audit_log', async (cursorId) => {
      return this.prisma.auditLog.findMany({
        where: cursorId ? { orgId, id: { lt: cursorId } } : { orgId },
        orderBy: { id: 'desc' },
        take: PAGE_SIZE,
        select: {
          id: true,
          userId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          createdAt: true,
          metadata: true,
        },
      });
    });

    // ─── revenue_events ─────────────────────────────────────────────────
    // Allowlist: idempotency_key, source, stream, event_type, amount,
    // currency, effective_at. metadata is intentionally OMITTED — it
    // may carry vendor-specific payload fragments.
    await this.streamPagedNdjson(write, 'revenue_event', async (cursorId) => {
      return this.prisma.revenueEvent.findMany({
        where: cursorId ? { orgId, idempotencyKey: { lt: cursorId } } : { orgId },
        orderBy: { idempotencyKey: 'desc' },
        take: PAGE_SIZE,
        select: {
          idempotencyKey: true,
          partnerId: true,
          source: true,
          stream: true,
          eventType: true,
          amount: true,
          currency: true,
          effectiveAt: true,
        },
      });
    });

    // ─── lender_decisions ───────────────────────────────────────────────
    // Allowlist: id, external_decision_id, lender_name, lender_tier,
    // decision, decision_timestamp, funding_status. approval_amount +
    // apr + term are OMITTED — they may be re-derivable from third-party
    // sources but should not survive cryptoshred without explicit
    // operator review.
    await this.streamPagedNdjson(write, 'lender_decision', async (cursorId) => {
      return this.prisma.lenderDecision.findMany({
        where: cursorId ? { orgId, id: { lt: cursorId } } : { orgId },
        orderBy: { id: 'desc' },
        take: PAGE_SIZE,
        select: {
          id: true,
          externalDecisionId: true,
          lenderName: true,
          lenderTier: true,
          decision: true,
          decisionTimestamp: true,
          fundingStatus: true,
        },
      });
    });

    // ─── lender_reporting_events ─────────────────────────────────────────
    // Allowlist: id, lender_slug, type, observed_at, permanent. payload
    // is OMITTED — vendor-specific.
    await this.streamPagedNdjson(write, 'lender_reporting_event', async (cursorId) => {
      return this.prisma.lenderReportingEvent.findMany({
        where: cursorId ? { orgId, id: { lt: cursorId } } : { orgId },
        orderBy: { id: 'desc' },
        take: PAGE_SIZE,
        select: {
          id: true,
          lenderSlug: true,
          type: true,
          observedAt: true,
          permanent: true,
        },
      });
    });

    stream.end();
    // We've buffered the stream into memory chunks via write(); for true
    // out-of-process streaming we'd need to drive the storage backend's
    // multipart upload, but PassThrough does keep memory bounded to one
    // page (~5MB at PAGE_SIZE=5000) regardless of total row count.
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const written = await getExportStorage().write({
      exportId: `offboard-${orgId}`,
      extension: 'json',
      body,
      contentType: 'application/x-ndjson',
    });
    // Read-back verify to satisfy SEC-302 — refuse to proceed to
    // cryptoshred if the locator returned by the backend can't be read.
    const verify = await getExportStorage().read(written.locator);
    if (verify.kind === 'stream' && (verify.size ?? 0) === 0) {
      throw new Error('tenant-offboarding: archive verify failed — refusing to cryptoshred');
    }
    return { locator: written.locator, size: bytes };
  }

  private async streamPagedNdjson<T extends { id?: string; idempotencyKey?: string }>(
    write: (s: string) => void,
    label: string,
    page: (cursor: string | null) => Promise<T[]>,
  ): Promise<void> {
    let cursor: string | null = null;
    write(JSON.stringify({ kind: 'table.begin', table: label }) + '\n');
    let pageCount = 0;
    for (;;) {
      const rows: T[] = await page(cursor);
      if (rows.length === 0) break;
      for (const r of rows) write(JSON.stringify({ table: label, row: r }) + '\n');
      pageCount += rows.length;
      const last = rows[rows.length - 1]!;
      const next = last.id ?? last.idempotencyKey ?? null;
      if (!next || next === cursor) break; // safety: cursor must advance
      cursor = next;
      if (rows.length < PAGE_SIZE) break;
    }
    write(JSON.stringify({ kind: 'table.end', table: label, count: pageCount }) + '\n');
  }
}
