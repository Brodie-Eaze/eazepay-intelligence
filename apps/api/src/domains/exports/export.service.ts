/**
 * Export service. Runs the actual data extraction for a given export job.
 *
 * Output strategy: write to local FS under ./tmp/exports/<id>.<ext>. In
 * production this swaps to S3 with a presigned URL — the public download
 * endpoint is the same shape, only the storage backend changes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ExportFormat, ExportStatus, ExportType, type PrismaClient } from '@prisma/client';

const STORAGE_ROOT = process.env.EXPORT_STORAGE_DIR ?? join(process.cwd(), 'tmp', 'exports');

export class ExportService {
  /**
   * Two clients:
   *   - `prisma` (writer)  → status updates on the Export row
   *   - `reader`           → heavy data fetches that produce the export bytes
   *
   * Status writes need read-after-write consistency (the worker reads its own
   * RUNNING marker before continuing, ditto the COMPLETED marker for the
   * download endpoint), so they go to the writer. The bulk extraction can
   * tolerate replication lag and is exactly the workload the replica is sized
   * for. If `reader` is omitted, both fall back to the writer (current
   * behaviour for tests / no-replica deployments).
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: PrismaClient = prisma,
  ) {}

  async runExport(exportId: string): Promise<void> {
    const exp = await this.prisma.export.findUnique({ where: { id: exportId } });
    if (!exp) throw new Error(`Export ${exportId} not found`);
    if (exp.status === ExportStatus.COMPLETED) return;

    await this.prisma.export.update({
      where: { id: exportId },
      data: { status: ExportStatus.RUNNING, startedAt: new Date() },
    });

    try {
      const { rows, columns } = await this.gatherRows(
        exp.type,
        exp.filters as Record<string, unknown>,
      );
      const filePath = join(STORAGE_ROOT, `${exp.id}.${this.extensionFor(exp.format)}`);
      await mkdir(dirname(filePath), { recursive: true });

      let body: string;
      if (exp.format === ExportFormat.JSON) {
        body = JSON.stringify({ exportId, type: exp.type, rowCount: rows.length, rows }, null, 2);
      } else {
        // Both CSV and XLSX get CSV body for now; XLSX → CSV-with-extension is acceptable until we wire xlsx writer.
        body = this.toCsv(columns, rows);
      }
      await writeFile(filePath, body, 'utf8');

      await this.prisma.export.update({
        where: { id: exportId },
        data: {
          status: ExportStatus.COMPLETED,
          completedAt: new Date(),
          rowCount: rows.length,
          filePath,
          fileBytes: Buffer.byteLength(body, 'utf8'),
          expiresAt: new Date(Date.now() + 24 * 3600_000), // 24h TTL on the download
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.export.update({
        where: { id: exportId },
        data: { status: ExportStatus.FAILED, error: msg, completedAt: new Date() },
      });
      throw err;
    }
  }

  private extensionFor(format: ExportFormat): string {
    switch (format) {
      case ExportFormat.CSV:
        return 'csv';
      case ExportFormat.JSON:
        return 'json';
      case ExportFormat.XLSX:
        return 'csv'; // xlsx-writer pending
    }
  }

  private async gatherRows(
    type: ExportType,
    filters: Record<string, unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }> {
    switch (type) {
      case ExportType.CUSTOMERS: {
        const apps = await this.reader.application.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10_000,
          include: { partner: { select: { id: true, name: true, externalId: true } } },
        });
        const seen = new Set<string>();
        const rows: Array<Record<string, unknown>> = [];
        for (const a of apps) {
          const key = a.consumerEmailHash.toString('hex');
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({
            customer_hash: key,
            latest_partner: a.partner.name,
            partner_external_id: a.partner.externalId,
            credit_score: a.creditScore ?? '',
            noted_income: a.notedAnnualIncome?.toString() ?? '',
            propensity: a.propensityScore?.toString() ?? '',
            available_credit: a.availableCredit?.toString() ?? '',
            open_lines: a.openLinesOfCredit ?? '',
            latest_status: a.status,
            latest_seen: a.createdAt.toISOString(),
          });
        }
        return { rows, columns: Object.keys(rows[0] ?? { customer_hash: '' }) };
      }

      case ExportType.APPLICATIONS: {
        const partnerId = typeof filters.partnerId === 'string' ? filters.partnerId : undefined;
        const apps = await this.reader.application.findMany({
          where: partnerId ? { partnerId } : {},
          orderBy: { createdAt: 'desc' },
          take: 50_000,
        });
        const rows = apps.map((a) => ({
          id: a.id,
          external_id: a.externalApplicationId,
          partner_id: a.partnerId,
          status: a.status,
          credit_score: a.creditScore ?? '',
          noted_income: a.notedAnnualIncome?.toString() ?? '',
          funding_estimate: a.fundingEstimate?.toString() ?? '',
          propensity: a.propensityScore?.toString() ?? '',
          submitted_at: a.submittedAt?.toISOString() ?? '',
          created_at: a.createdAt.toISOString(),
        }));
        return { rows, columns: Object.keys(rows[0] ?? { id: '' }) };
      }

      case ExportType.LENDER_DECISIONS: {
        const decisions = await this.reader.lenderDecision.findMany({
          orderBy: { decisionTimestamp: 'desc' },
          take: 50_000,
        });
        const rows = decisions.map((d) => ({
          id: d.id,
          application_id: d.applicationId,
          partner_id: d.partnerId,
          lender: d.lenderName,
          tier: d.lenderTier,
          decision: d.decision,
          decision_at: d.decisionTimestamp.toISOString(),
          approval_amount: d.approvalAmount?.toString() ?? '',
          apr: d.apr?.toString() ?? '',
          term: d.term ?? '',
          funding_status: d.fundingStatus,
          funding_amount: d.fundingAmount?.toString() ?? '',
          funded_at: d.fundingTimestamp?.toISOString() ?? '',
        }));
        return { rows, columns: Object.keys(rows[0] ?? { id: '' }) };
      }

      case ExportType.REVENUE_LEDGER: {
        const events = await this.reader.revenueEvent.findMany({
          orderBy: { effectiveAt: 'desc' },
          take: 50_000,
        });
        const rows = events.map((e) => ({
          idempotency_key: e.idempotencyKey,
          partner_id: e.partnerId,
          lender_decision_id: e.lenderDecisionId ?? '',
          source: e.source,
          stream: e.stream,
          event_type: e.eventType,
          amount: e.amount.toString(),
          currency: e.currency,
          effective_at: e.effectiveAt.toISOString(),
          recorded_at: e.recordedAt.toISOString(),
        }));
        return { rows, columns: Object.keys(rows[0] ?? { idempotency_key: '' }) };
      }

      case ExportType.PARTNERS: {
        const partners = await this.reader.partner.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        const rows = partners.map((p) => ({
          id: p.id,
          external_id: p.externalId,
          name: p.name,
          industry: p.industry,
          status: p.status,
          tier: p.tier,
          contract_value: p.contractValue.toString(),
          buzzpay_rev_share_pct: p.buzzpayRevSharePct.toString(),
          pixie_margin_per_pull: p.pixieMargin.toString(),
          onboarded_at: p.onboardingDate.toISOString(),
        }));
        return { rows, columns: Object.keys(rows[0] ?? { id: '' }) };
      }

      case ExportType.AUDIT_LOG: {
        const rows = await this.reader.auditLog.findMany({
          orderBy: { createdAt: 'desc' },
          take: 50_000,
          include: { user: { select: { email: true, role: true } } },
        });
        const out = rows.map((r) => ({
          id: r.id,
          at: r.createdAt.toISOString(),
          actor: r.user?.email ?? 'system',
          actor_role: r.user?.role ?? '',
          action: r.action,
          resource_type: r.resourceType,
          resource_id: r.resourceId ?? '',
          ip: r.ipAddress ?? '',
          metadata: JSON.stringify(r.metadata ?? {}),
        }));
        return { rows: out, columns: Object.keys(out[0] ?? { id: '' }) };
      }
    }
  }

  private toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const header = columns.join(',');
    const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
    return `${header}\n${body}\n`;
  }
}
