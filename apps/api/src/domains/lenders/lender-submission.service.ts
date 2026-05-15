/**
 * Lender-submission service (GAP-101).
 *
 * Bridges the rest of the application to the LenderAdapter contract.
 * Routes call `submitToLender(applicationId, lenderSlug)`; this service
 * loads the application + partner, decrypts PII under the per-org DEK,
 * hands the normalised payload to the adapter, persists the resulting
 * LenderDecision row, and writes a LenderReportingEvent.
 *
 * The same shape is reused by the polling worker — `pollOne(externalDecisionId)`
 * updates the LenderDecision row and emits a STATE_TRANSITION
 * LenderReportingEvent when the decision or funding status flips.
 */
import { v7 as uuidv7 } from 'uuid';
import {
  LenderReportingEventType,
  Prisma,
  type LenderDecision,
  type PrismaClient,
} from '@prisma/client';
import { getLogger } from '../../config/logger.js';
import { errors } from '../../shared/errors/app-error.js';
import { decryptEnvelopeAuto } from '../../shared/kms/tenant-dek.js';
import { decryptPII } from '../../shared/utils/encryption.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { withTenantSession } from '../../shared/tenant/tenant-context.js';
import type { LenderAdapter } from './adapter/lender-adapter.interface.js';
import { getLenderAdapter } from './adapter/lender-adapter-registry.js';

export class LenderSubmissionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Submit a single application to a single lender. Idempotent in the
   * adapter (the mock's `externalDecisionId` is deterministic from
   * orgId+applicationId); the upsert below de-dupes if a prior submit
   * happened.
   */
  async submitToLender(args: {
    applicationId: string;
    lenderSlug: string;
    /** Amount the consumer is requesting in decimal-string. */
    requestedAmount: string;
  }): Promise<LenderDecision> {
    const adapter = getLenderAdapter(args.lenderSlug);
    if (!adapter) {
      throw errors.notFound('Lender', args.lenderSlug);
    }
    if (!adapter.isReady()) {
      throw errors.badRequest(`Lender ${args.lenderSlug} adapter is not ready`);
    }

    const app = await this.prisma.application.findUnique({
      where: { id: args.applicationId },
      include: { partner: true },
    });
    if (!app) throw errors.notFound('Application', args.applicationId);

    return withTenantSession(this.prisma, { orgId: app.orgId }, async (tx) => {
      const db = tx as unknown as PrismaClient;

      // Decrypt PII under the per-org DEK (Phase 3). The adapter receives
      // plaintext but MUST NOT log it — that's an adapter contract.
      const [name, email, phone] = await Promise.all([
        decryptEnvelopeAuto(db, app.consumerNameCiphertext, decryptPII),
        decryptEnvelopeAuto(db, app.consumerEmailCiphertext, decryptPII),
        decryptEnvelopeAuto(db, app.consumerPhoneCiphertext, decryptPII),
      ]);

      try {
        const result = await adapter.submitApplication({
          applicationId: app.id,
          orgId: app.orgId,
          partnerExternalId: app.partner.externalId,
          consumer: { name, email, phoneE164: phone },
          financials: {
            creditScore: app.creditScore,
            notedAnnualIncome: app.notedAnnualIncome?.toString() ?? null,
            availableCredit: app.availableCredit?.toString() ?? null,
            openLinesOfCredit: app.openLinesOfCredit ?? null,
          },
          requestedAmount: args.requestedAmount,
        });

        // Persist the decision row + append a SUBMIT reporting event in
        // one transaction so the audit log is never out of sync.
        const decision = await db.lenderDecision.upsert({
          where: {
            orgId_externalDecisionId: {
              orgId: app.orgId,
              externalDecisionId: result.externalDecisionId,
            },
          },
          create: {
            id: uuidv7(),
            orgId: app.orgId,
            externalDecisionId: result.externalDecisionId,
            applicationId: app.id,
            partnerId: app.partnerId,
            lenderName: result.lenderName,
            lenderTier: result.lenderTier,
            decision: 'PENDING',
            decisionTimestamp: result.submittedAt,
          },
          update: {},
        });
        await db.lenderReportingEvent.create({
          data: {
            id: uuidv7(),
            orgId: app.orgId,
            applicationId: app.id,
            lenderSlug: adapter.slug,
            externalDecisionId: result.externalDecisionId,
            type: LenderReportingEventType.SUBMIT,
            payload: {
              lenderName: result.lenderName,
              lenderTier: result.lenderTier,
            },
            permanent: false,
            observedAt: result.submittedAt,
          },
        });
        await writeAuditLog({
          orgId: app.orgId,
          action: 'WEBHOOK_PROCESSED',
          resourceType: 'lender_decision',
          resourceId: decision.id,
          metadata: { lender: adapter.slug, externalDecisionId: result.externalDecisionId },
        });
        return decision;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.lenderReportingEvent.create({
          data: {
            id: uuidv7(),
            orgId: app.orgId,
            applicationId: app.id,
            lenderSlug: adapter.slug,
            externalDecisionId: null,
            type: LenderReportingEventType.SUBMIT_FAILED,
            payload: { error: msg.slice(0, 8000) },
            permanent: false,
            observedAt: new Date(),
          },
        });
        getLogger().error(
          {
            errorId: 'lender.submit_failed',
            lender: adapter.slug,
            applicationId: app.id,
            err: msg,
          },
          'lender.submit_failed',
        );
        throw err;
      }
    });
  }

  /**
   * Poll one decision and reconcile any state changes. Used by the
   * polling worker (and by replay surfaces). No-op if the decision is
   * already in a terminal state with funding settled.
   */
  async pollOne(adapter: LenderAdapter, decisionId: string): Promise<void> {
    const decision = await this.prisma.lenderDecision.findUnique({
      where: { id: decisionId },
    });
    if (!decision?.externalDecisionId) return;
    if (decision.decision !== 'PENDING' && decision.fundingStatus === 'FUNDED') {
      // Terminal — nothing to poll.
      return;
    }
    return withTenantSession(this.prisma, { orgId: decision.orgId }, async (tx) => {
      const db = tx as unknown as PrismaClient;
      try {
        const result = await adapter.pollDecision(decision.externalDecisionId!);
        const before = {
          decision: decision.decision,
          fundingStatus: decision.fundingStatus,
        };
        await db.lenderDecision.update({
          where: { id: decision.id },
          data: {
            decision: result.decision,
            approvalAmount: result.approvalAmount
              ? new Prisma.Decimal(result.approvalAmount)
              : decision.approvalAmount,
            apr: result.apr ? new Prisma.Decimal(result.apr) : decision.apr,
            term: result.term ?? decision.term,
            monthlyPayment: result.monthlyPayment
              ? new Prisma.Decimal(result.monthlyPayment)
              : decision.monthlyPayment,
            originationFee: result.originationFee
              ? new Prisma.Decimal(result.originationFee)
              : decision.originationFee,
            fundingStatus: result.fundingStatus,
            fundingAmount: result.fundingAmount
              ? new Prisma.Decimal(result.fundingAmount)
              : decision.fundingAmount,
            fundingTimestamp: result.fundingTimestamp ?? decision.fundingTimestamp,
          },
        });
        await db.lenderReportingEvent.create({
          data: {
            id: uuidv7(),
            orgId: decision.orgId,
            applicationId: decision.applicationId,
            lenderSlug: adapter.slug,
            externalDecisionId: decision.externalDecisionId,
            type:
              before.decision !== result.decision || before.fundingStatus !== result.fundingStatus
                ? LenderReportingEventType.STATE_TRANSITION
                : LenderReportingEventType.POLL,
            payload: { before, after: result } as unknown as Prisma.InputJsonValue,
            permanent: false,
            observedAt: result.observedAt,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.lenderReportingEvent.create({
          data: {
            id: uuidv7(),
            orgId: decision.orgId,
            applicationId: decision.applicationId,
            lenderSlug: adapter.slug,
            externalDecisionId: decision.externalDecisionId,
            type: LenderReportingEventType.POLL_FAILED,
            payload: { error: msg.slice(0, 8000) },
            permanent: false,
            observedAt: new Date(),
          },
        });
        getLogger().error(
          { errorId: 'lender.poll_failed', lender: adapter.slug, decisionId, err: msg },
          'lender.poll_failed',
        );
      }
    });
  }
}
