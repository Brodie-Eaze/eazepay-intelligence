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
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { withSpan } from '../../shared/utils/tracing.js';

export interface SubmitInput {
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

  private async processInner(
    requestId: string,
    span: import('@opentelemetry/api').Span,
  ): Promise<RtbfRequest> {
    const req = await this.prisma.rtbfRequest.findUnique({ where: { id: requestId } });
    if (!req) throw errors.notFound('RtbfRequest', requestId);
    if (req.status === 'COMPLETED') return req;
    if (req.status === 'FAILED')
      throw errors.badRequest('Request previously failed; create a new one to retry');

    // Mark PROCESSING + capture start time.
    await this.prisma.rtbfRequest.update({
      where: { id: req.id },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    try {
      const apps = await this.prisma.application.findMany({
        where: { consumerEmailHash: req.emailHash },
        select: { id: true },
      });

      const zero32 = Buffer.alloc(32, 0); // matches the smallest ciphertext envelope size
      // Use a single transaction so a partial scrub doesn't leave the
      // request "half-erased" if the worker crashes mid-flight.
      await this.prisma.$transaction(async (tx) => {
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
      });

      const completed = await this.prisma.rtbfRequest.update({
        where: { id: req.id },
        data: {
          status: 'COMPLETED' satisfies RtbfRequestStatus,
          completedAt: new Date(),
          applicationsScrubbed: apps.length,
        },
      });
      span.setAttribute('rtbf.applications_scrubbed', apps.length);

      await writeAuditLog({
        userId: req.requestedById,
        action: 'RTBF_PROCESSED',
        resourceType: 'rtbf_request',
        resourceId: req.id,
        metadata: {
          applicationsScrubbed: apps.length,
          emailHashHex: req.emailHash.toString('hex'),
        },
      });
      return completed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failed = await this.prisma.rtbfRequest.update({
        where: { id: req.id },
        data: { status: 'FAILED', completedAt: new Date(), error: msg.slice(0, 1000) },
      });
      await writeAuditLog({
        userId: req.requestedById,
        action: 'RTBF_FAILED',
        resourceType: 'rtbf_request',
        resourceId: req.id,
        metadata: { error: msg.slice(0, 200) },
      });
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
