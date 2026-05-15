/**
 * Right-to-be-forgotten (GDPR Art. 17 / Australian Privacy Principles).
 *
 * Process per request:
 *
 *   1. submit(emailHash, requestedById, reason)
 *      Creates a PENDING `rtbf_requests` row. Idempotent on `(emailHash)`
 *      where status IN ('PENDING','PROCESSING') — a duplicate submission
 *      returns the existing in-flight request.
 *
 *   2. process(requestId)
 *      Finds every Application carrying `consumerEmailHash = emailHash`
 *      and overwrites these encrypted columns with zero buffers in a
 *      single transaction:
 *          consumer_name_ciphertext, consumer_email_ciphertext,
 *          consumer_phone_ciphertext, consumer_email_hash,
 *          consumer_phone_hash
 *      The IV+tag inside each AES-GCM envelope are part of the ciphertext
 *      bytes, so zeroing the column makes the data cryptographically
 *      unrecoverable even with the platform's master key.
 *
 *      Stamps the request COMPLETED with applicationsScrubbed count and
 *      writes an RTBF_PROCESSED audit row.
 *
 * Why we keep the rows after scrub
 *   LenderDecision and RevenueEvent reference Application; a hard delete
 *   would orphan financial records that have a 7-year regulatory
 *   retention. Cryptoshred + scrub + audit is the GDPR-aligned compromise
 *   — the data subject's PII is irrecoverable, the financial trail
 *   survives.
 *
 * SOC 2 mapping
 *   - CC6.1 — RTBF endpoint admin-only
 *   - CC7.3 — every submission + processing step audit-logged
 *   - Privacy/Confidentiality — fulfils Art. 17 / APP 12 / APP 13
 */
import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient, RtbfRequest, RtbfRequestStatus } from '@prisma/client';
import type { Span } from '@opentelemetry/api';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { withSpan } from '../../shared/utils/tracing.js';

export interface SubmitInput {
  /**
   * Phase 1 retrofit: RTBF requests are org-scoped. The tenant whose data is
   * being erased. Caller (route handler) sources this from req.auth.orgId.
   */
  orgId: string;
  emailHash: Buffer;
  requestedById: string;
  reason?: string;
}

export class RtbfService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Submit a new RTBF request. Idempotent: if an in-flight request exists
   * for the same email hash, returns it. Audit-logged.
   */
  async submit(input: SubmitInput): Promise<RtbfRequest> {
    const existing = await this.prisma.rtbfRequest.findFirst({
      where: { emailHash: input.emailHash, status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) return existing;

    const created = await this.prisma.rtbfRequest.create({
      data: {
        id: uuidv7(),
        orgId: input.orgId,
        emailHash: input.emailHash,
        requestedById: input.requestedById,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    await writeAuditLog({
      userId: input.requestedById,
      action: 'RTBF_SUBMITTED',
      resourceType: 'rtbf_request',
      resourceId: created.id,
      metadata: {
        emailHashHex: input.emailHash.toString('hex'),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    return created;
  }

  /**
   * Process a PENDING request. Cryptoshreds every Application with the
   * matching email hash. Idempotent on completed requests.
   */
  async process(requestId: string): Promise<RtbfRequest> {
    return withSpan('rtbf.process', async (span) => {
      span.setAttribute('rtbf.request_id', requestId);
      return this.processInner(requestId, span);
    });
  }

  private async processInner(requestId: string, span: Span): Promise<RtbfRequest> {
    const initial = await this.prisma.rtbfRequest.findUnique({ where: { id: requestId } });
    if (!initial) throw errors.notFound('RtbfRequest', requestId);
    if (initial.status === 'COMPLETED') return initial;
    if (initial.status === 'FAILED')
      throw errors.badRequest('Request previously failed; create a new one to retry');
    // PROCESSING is treated as resumable — a previous worker crashed mid-tx,
    // we re-enter the same logic. The transaction below is idempotent under
    // re-entry: the ciphertext columns are overwritten with zeros, and the
    // unique constraint on the request prevents double-completion.

    const zero32 = Buffer.alloc(32, 0); // matches the smallest ciphertext envelope size

    // The PROCESSING status flip, the application scan, the cryptoshred,
    // the COMPLETED stamp, and the RTBF_PROCESSED audit row all run in a
    // single transaction. A crash mid-flight rolls back to PENDING (status
    // never moves) and the lifecycle worker picks the request up again on
    // its next tick. The application scan is intentionally inside the tx
    // so a concurrent webhook that creates a new Application matching the
    // email hash either lands before our scan (will be scrubbed) or after
    // our commit (will be picked up by the next RTBF cycle, which the
    // submit() idempotency check turns into a re-evaluation).
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.rtbfRequest.update({
          where: { id: initial.id },
          data: { status: 'PROCESSING', startedAt: new Date() },
        });

        const apps = await tx.application.findMany({
          where: { consumerEmailHash: initial.emailHash },
          select: { id: true },
        });

        for (const a of apps) {
          await tx.application.update({
            where: { id: a.id },
            data: {
              consumerNameCiphertext: zero32,
              consumerEmailCiphertext: zero32,
              consumerPhoneCiphertext: zero32,
              consumerEmailHash: zero32,
              consumerPhoneHash: zero32,
            },
          });
        }

        // GAP-111 / SEC-145 / ARCH-115: scrub credit_enrichments PII echo
        // alongside applications. HighSale's snapshot mirrors the consumer
        // PII into credit_enrichments (name / email / phone / dob /
        // address ciphertexts) per the architecture doc § Plane 2. Before
        // this fix, RTBF only touched `applications` — every HighSale
        // snapshot for the data subject survived erasure, breaking the
        // GDPR Art. 17 / APP 11 completeness guarantee. We zero out every
        // ciphertext column (40-byte AES-256-GCM envelope minimum, but
        // zero-fill works for any length since the cipher will fail on
        // read), zero the lookup hashes so the row no longer joins, and
        // soft-delete via deletedAt so downstream list endpoints don't
        // surface the empty row.
        const zero40 = Buffer.alloc(40, 0);
        const enrichments = await tx.creditEnrichment.findMany({
          where: { consumerEmailHash: initial.emailHash, deletedAt: null },
          select: { id: true },
        });
        for (const e of enrichments) {
          await tx.creditEnrichment.update({
            where: { id: e.id },
            data: {
              consumerNameCiphertext: zero40,
              consumerEmailCiphertext: zero40,
              consumerEmailHash: zero32,
              consumerPhoneCiphertext: zero40,
              consumerPhoneHash: zero32,
              dateOfBirthCiphertext: zero40,
              dateOfBirthHash: zero32,
              addressCiphertext: zero40,
              deletedAt: new Date(),
            },
          });
        }

        const completed = await tx.rtbfRequest.update({
          where: { id: initial.id },
          data: {
            status: 'COMPLETED' satisfies RtbfRequestStatus,
            completedAt: new Date(),
            applicationsScrubbed: apps.length,
            creditEnrichmentsScrubbed: enrichments.length,
          },
        });

        // Audit row in the same tx so a rolled-back scrub cannot leave a
        // phantom RTBF_PROCESSED row, and a successful scrub cannot land
        // without its audit. CC7.3 / APP 13.
        await tx.auditLog.create({
          data: {
            id: uuidv7(),
            userId: initial.requestedById,
            action: 'RTBF_PROCESSED',
            resourceType: 'rtbf_request',
            resourceId: initial.id,
            metadata: {
              applicationsScrubbed: apps.length,
              creditEnrichmentsScrubbed: enrichments.length,
              emailHashHex: initial.emailHash.toString('hex'),
            },
          },
        });

        return {
          completed,
          scrubbed: apps.length,
          creditEnrichmentsScrubbed: enrichments.length,
        };
      });

      span.setAttribute('rtbf.applications_scrubbed', result.scrubbed);
      span.setAttribute('rtbf.credit_enrichments_scrubbed', result.creditEnrichmentsScrubbed);
      return result.completed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fail-state recording is best-effort outside the rolled-back tx.
      const failed = await this.prisma.rtbfRequest
        .update({
          where: { id: initial.id },
          data: { status: 'FAILED', completedAt: new Date(), error: msg.slice(0, 1000) },
        })
        .catch(() => null);
      await writeAuditLog({
        userId: initial.requestedById,
        action: 'RTBF_FAILED',
        resourceType: 'rtbf_request',
        resourceId: initial.id,
        metadata: { error: msg.slice(0, 200) },
      }).catch(() => undefined);
      throw Object.assign(new Error(msg), { failed });
    }
  }

  async list(filter?: { status?: RtbfRequestStatus; limit?: number }): Promise<RtbfRequest[]> {
    return this.prisma.rtbfRequest.findMany({
      where: filter?.status ? { status: filter.status } : {},
      orderBy: { requestedAt: 'desc' },
      take: filter?.limit ?? 50,
    });
  }
}
