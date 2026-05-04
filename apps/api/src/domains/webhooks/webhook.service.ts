import { Prisma, RevenueEventType, RevenueStream, WebhookSource } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { encryptPII } from '../../shared/utils/encryption.js';
import { errors } from '../../shared/errors/app-error.js';
import { publishWsEvent, withPartnerLabel } from '../../shared/utils/ws-publisher.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import {
  BuzzpayApplicationWebhookSchema,
  BuzzpayClawbackWebhookSchema,
  BuzzpayFundingWebhookSchema,
  BuzzpayLenderDecisionWebhookSchema,
  MicampProcessingWebhookSchema,
  MicampReversalWebhookSchema,
  PixieUsageWebhookSchema,
} from './webhook.schemas.js';
import { computePixieMargin } from '../pixie/pixie.algorithm.js';

export interface ProcessJobInput {
  webhookEventId: string;
  source: WebhookSource;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
}

export class WebhookProcessor {
  constructor(private readonly prisma: PrismaClient) {}

  async process(job: ProcessJobInput): Promise<void> {
    try {
      switch (job.source) {
        case WebhookSource.BUZZPAY:
          await this.handleBuzzpay(job);
          break;
        case WebhookSource.PIXIE:
          await this.handlePixie(job);
          break;
        case WebhookSource.MICAMP:
          await this.handleMicamp(job);
          break;
      }
      await this.prisma.webhookEvent.update({
        where: { id: job.webhookEventId },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      await writeAuditLog({
        action: 'WEBHOOK_PROCESSED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: { source: job.source, eventType: job.eventType },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookEvent.update({
        where: { id: job.webhookEventId },
        data: { status: 'FAILED', processingError: message },
      });
      await writeAuditLog({
        action: 'WEBHOOK_FAILED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: { source: job.source, eventType: job.eventType, error: message },
      });
      throw err;
    }
  }

  // ─── BuzzPay ────────────────────────────────────────────────────────────

  private async handleBuzzpay(job: ProcessJobInput): Promise<void> {
    switch (job.eventType) {
      case 'application':
        return this.processBuzzpayApplication(job);
      case 'lender-decision':
        return this.processBuzzpayDecision(job);
      case 'funding-status':
        return this.processBuzzpayFunding(job);
      case 'clawback':
        return this.processBuzzpayClawback(job);
      default:
        throw errors.badRequest(`Unknown BuzzPay event type: ${job.eventType}`);
    }
  }

  private async processBuzzpayApplication(job: ProcessJobInput): Promise<void> {
    const data = BuzzpayApplicationWebhookSchema.parse(job.payload);
    const partner = await this.prisma.partner.findFirst({
      where: { externalId: data.partnerExternalId, deletedAt: null },
    });
    if (!partner) throw errors.notFound('Partner', data.partnerExternalId);

    const name = encryptPII(data.consumer.name);
    const email = encryptPII(data.consumer.email);
    const phone = encryptPII(data.consumer.phone);

    const app = await this.prisma.application.upsert({
      where: { externalApplicationId: data.externalApplicationId },
      create: {
        id: uuidv7(),
        partnerId: partner.id,
        externalApplicationId: data.externalApplicationId,
        consumerNameCiphertext: name.ciphertext,
        consumerEmailCiphertext: email.ciphertext,
        consumerEmailHash: email.hash,
        consumerPhoneCiphertext: phone.ciphertext,
        consumerPhoneHash: phone.hash,
        creditScore: data.enrichment.creditScore ?? null,
        availableCredit: data.enrichment.availableCredit ? new Prisma.Decimal(data.enrichment.availableCredit) : null,
        notedAnnualIncome: data.enrichment.notedAnnualIncome ? new Prisma.Decimal(data.enrichment.notedAnnualIncome) : null,
        bankStatementsProvided: data.enrichment.bankStatementsProvided ?? false,
        merchantPreapproval: data.enrichment.merchantPreapproval ?? false,
        merchantPreapprovalAmount: data.enrichment.merchantPreapprovalAmount
          ? new Prisma.Decimal(data.enrichment.merchantPreapprovalAmount) : null,
        consumerPreapproval: data.enrichment.consumerPreapproval ?? false,
        consumerPreapprovalAmount: data.enrichment.consumerPreapprovalAmount
          ? new Prisma.Decimal(data.enrichment.consumerPreapprovalAmount) : null,
        fundingEstimate: data.enrichment.fundingEstimate ? new Prisma.Decimal(data.enrichment.fundingEstimate) : null,
        propensityScore: data.enrichment.propensityScore ? new Prisma.Decimal(data.enrichment.propensityScore) : null,
        openLinesOfCredit: data.enrichment.openLinesOfCredit ?? null,
        status: data.status,
        submittedAt: data.submittedAt ? new Date(data.submittedAt) : new Date(),
      },
      update: {
        status: data.status,
        submittedAt: data.submittedAt ? new Date(data.submittedAt) : undefined,
      },
    });
    await publishWsEvent(
      withPartnerLabel({
        type: 'application.created',
        at: new Date().toISOString(),
        partnerId: partner.id,
        applicationId: app.id,
      }),
    );
  }

  private async processBuzzpayDecision(job: ProcessJobInput): Promise<void> {
    const data = BuzzpayLenderDecisionWebhookSchema.parse(job.payload);
    const application = await this.prisma.application.findUnique({
      where: { externalApplicationId: data.externalApplicationId },
    });
    if (!application) throw errors.notFound('Application', data.externalApplicationId);

    const id = uuidv7();
    const decision = await this.prisma.lenderDecision.upsert({
      where: { id: data.decisionId.startsWith('uuid:') ? data.decisionId.slice(5) : id },
      create: {
        id,
        applicationId: application.id,
        partnerId: application.partnerId,
        lenderName: data.lenderName,
        lenderTier: data.lenderTier,
        decision: data.decision,
        decisionTimestamp: new Date(data.decisionTimestamp),
        approvalAmount: data.approvalAmount ? new Prisma.Decimal(data.approvalAmount) : null,
        apr: data.apr ? new Prisma.Decimal(data.apr) : null,
        term: data.term ?? null,
        monthlyPayment: data.monthlyPayment ? new Prisma.Decimal(data.monthlyPayment) : null,
        originationFee: data.originationFee ? new Prisma.Decimal(data.originationFee) : null,
      },
      update: {
        decision: data.decision,
        decisionTimestamp: new Date(data.decisionTimestamp),
      },
    });

    if (data.decision === 'APPROVED' || data.decision === 'DECLINED') {
      await publishWsEvent(
        withPartnerLabel({
          type: 'lender.decision',
          at: new Date().toISOString(),
          partnerId: application.partnerId,
          lender: data.lenderName,
          outcome: data.decision,
          amount: data.approvalAmount ?? null,
        }),
      );
    }

    if (data.decision === 'APPROVED') {
      await this.prisma.application.update({
        where: { id: application.id },
        data: { status: 'APPROVED' },
      });
    } else if (data.decision === 'DECLINED') {
      // Only set to DECLINED if no other lender approved.
      const anyApproved = await this.prisma.lenderDecision.count({
        where: { applicationId: application.id, decision: 'APPROVED' },
      });
      if (!anyApproved) {
        await this.prisma.application.update({
          where: { id: application.id },
          data: { status: 'DECLINED' },
        });
      }
    }
    void decision; // referenced for clarity; future hook point for analytics emission
  }

  private async processBuzzpayFunding(job: ProcessJobInput): Promise<void> {
    const data = BuzzpayFundingWebhookSchema.parse(job.payload);
    const decision = await this.prisma.lenderDecision.findUnique({ where: { id: data.decisionId } });
    if (!decision) throw errors.notFound('LenderDecision', data.decisionId);

    await this.prisma.lenderDecision.update({
      where: { id: decision.id },
      data: {
        fundingStatus: data.fundingStatus,
        fundingTimestamp: new Date(data.fundingTimestamp),
        fundingAmount: data.fundingAmount ? new Prisma.Decimal(data.fundingAmount) : null,
      },
    });

    if (data.fundingStatus === 'FUNDED') {
      await this.prisma.application.update({
        where: { id: decision.applicationId },
        data: { status: 'FUNDED' },
      });
      // Record EazePay revenue at funding time.
      const amount = new Prisma.Decimal(data.eazepayRevenue ?? '0');
      if (!amount.isZero()) {
        await this.recordRevenue({
          partnerId: decision.partnerId,
          lenderDecisionId: decision.id,
          source: WebhookSource.BUZZPAY,
          stream: RevenueStream.BUZZPAY,
          eventType: RevenueEventType.FUNDING,
          amount,
          effectiveAt: new Date(data.fundingTimestamp),
          idempotencyKey: `buzzpay:funding:${decision.id}`,
          metadata: { decisionId: decision.id },
        });
      }
      await publishWsEvent(
        withPartnerLabel({
          type: 'funding.completed',
          at: new Date().toISOString(),
          partnerId: decision.partnerId,
          amount: data.fundingAmount ?? '0',
        }),
      );
    } else {
      await publishWsEvent(
        withPartnerLabel({
          type: 'funding.failed',
          at: new Date().toISOString(),
          partnerId: decision.partnerId,
          reason: data.failureReason ?? 'unknown',
        }),
      );
    }
  }

  private async processBuzzpayClawback(job: ProcessJobInput): Promise<void> {
    const data = BuzzpayClawbackWebhookSchema.parse(job.payload);
    const decision = await this.prisma.lenderDecision.findUnique({ where: { id: data.decisionId } });
    if (!decision) throw errors.notFound('LenderDecision', data.decisionId);
    const amount = new Prisma.Decimal(data.amount).neg(); // negative event
    await this.recordRevenue({
      partnerId: decision.partnerId,
      lenderDecisionId: decision.id,
      source: WebhookSource.BUZZPAY,
      stream: RevenueStream.BUZZPAY,
      eventType: RevenueEventType.CLAWBACK,
      amount,
      effectiveAt: new Date(data.effectiveAt),
      idempotencyKey: `buzzpay:clawback:${decision.id}:${data.effectiveAt}`,
      metadata: { reason: data.reason },
    });
  }

  // ─── Pixie ──────────────────────────────────────────────────────────────

  private async handlePixie(job: ProcessJobInput): Promise<void> {
    if (job.eventType !== 'usage') {
      throw errors.badRequest(`Unknown Pixie event type: ${job.eventType}`);
    }
    const data = PixieUsageWebhookSchema.parse(job.payload);
    const env = getEnv();
    const date = new Date(data.date);
    const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86_399_999);

    for (const p of data.partners) {
      const partner = await this.prisma.partner.findFirst({
        where: { externalId: p.partnerExternalId, deletedAt: null },
      });
      if (!partner) continue;

      const { costPerPull, chargePerPull, marginPerPull, total } = computePixieMargin({
        collectivePulls: data.collectivePulls,
        partnerPulls: p.pulls,
        breakpoint: env.PIXIE_VOLUME_BREAKPOINT,
        baseCost: env.PIXIE_COST_PER_PULL,
        baseCharge: env.PIXIE_CHARGE_PER_PULL,
      });

      const cumulativeRow = await this.prisma.pixieMetric.aggregate({
        where: { partnerId: partner.id },
        _sum: { dataPullsThisPeriod: true },
      });
      const cumulative = (cumulativeRow._sum.dataPullsThisPeriod ?? 0) + p.pulls;

      await this.prisma.pixieMetric.upsert({
        where: { periodStart_partnerId_period: { periodStart: dayStart, partnerId: partner.id, period: 'DAILY' } },
        create: {
          partnerId: partner.id,
          period: 'DAILY',
          periodStart: dayStart,
          periodEnd: dayEnd,
          dataPullsThisPeriod: p.pulls,
          dataPullsCumulative: cumulative,
          costPerPull: new Prisma.Decimal(costPerPull),
          chargePerPull: new Prisma.Decimal(chargePerPull),
          profitPerPull: new Prisma.Decimal(marginPerPull),
          totalRevenue: new Prisma.Decimal(total),
          volumeThreshold: env.PIXIE_VOLUME_BREAKPOINT,
          volumeAchieved: data.collectivePulls,
          discountApplied: new Prisma.Decimal('0'),
        },
        update: {
          dataPullsThisPeriod: p.pulls,
          dataPullsCumulative: cumulative,
          costPerPull: new Prisma.Decimal(costPerPull),
          chargePerPull: new Prisma.Decimal(chargePerPull),
          profitPerPull: new Prisma.Decimal(marginPerPull),
          totalRevenue: new Prisma.Decimal(total),
          volumeAchieved: data.collectivePulls,
        },
      });

      if (Number(total) !== 0) {
        await this.recordRevenue({
          partnerId: partner.id,
          source: WebhookSource.PIXIE,
          stream: RevenueStream.PIXIE,
          eventType: RevenueEventType.PIXIE_MARGIN,
          amount: new Prisma.Decimal(total),
          effectiveAt: dayStart,
          idempotencyKey: `pixie:margin:${partner.id}:${dayStart.toISOString()}`,
          metadata: { pulls: p.pulls, collective: data.collectivePulls },
        });
      }
      await publishWsEvent(
        withPartnerLabel({
          type: 'pixie.usage_reported',
          at: new Date().toISOString(),
          partnerId: partner.id,
          pulls: p.pulls,
        }),
      );
    }
  }

  // ─── MiCamp ─────────────────────────────────────────────────────────────

  private async handleMicamp(job: ProcessJobInput): Promise<void> {
    switch (job.eventType) {
      case 'processing': {
        const data = MicampProcessingWebhookSchema.parse(job.payload);
        const partner = await this.prisma.partner.findFirst({
          where: { externalId: data.partnerExternalId, deletedAt: null },
        });
        if (!partner) throw errors.notFound('Partner', data.partnerExternalId);
        // 50/50 split — half is EazePay revenue.
        const ours = new Prisma.Decimal(data.grossProcessingFee).div(2);
        await this.recordRevenue({
          partnerId: partner.id,
          source: WebhookSource.MICAMP,
          stream: RevenueStream.MICAMP,
          eventType: RevenueEventType.PROCESSING_FEE,
          amount: ours,
          effectiveAt: new Date(data.effectiveAt),
          idempotencyKey: `micamp:processing:${partner.id}:${data.effectiveAt}`,
          metadata: { txnCount: data.txnCount, gross: data.grossProcessingFee },
        });
        return;
      }
      case 'reversal': {
        const data = MicampReversalWebhookSchema.parse(job.payload);
        const partner = await this.prisma.partner.findFirst({
          where: { externalId: data.partnerExternalId, deletedAt: null },
        });
        if (!partner) throw errors.notFound('Partner', data.partnerExternalId);
        const amount = new Prisma.Decimal(data.reversalAmount).div(2).neg();
        await this.recordRevenue({
          partnerId: partner.id,
          source: WebhookSource.MICAMP,
          stream: RevenueStream.MICAMP,
          eventType: RevenueEventType.REVERSAL,
          amount,
          effectiveAt: new Date(data.effectiveAt),
          idempotencyKey: `micamp:reversal:${partner.id}:${data.effectiveAt}`,
          metadata: { reason: data.reason },
        });
        return;
      }
      default:
        throw errors.badRequest(`Unknown MiCamp event type: ${job.eventType}`);
    }
  }

  private async recordRevenue(args: {
    partnerId: string;
    lenderDecisionId?: string;
    source: WebhookSource;
    stream: RevenueStream;
    eventType: RevenueEventType;
    amount: Prisma.Decimal;
    effectiveAt: Date;
    idempotencyKey: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.revenueEvent.create({
        data: {
          partnerId: args.partnerId,
          lenderDecisionId: args.lenderDecisionId ?? null,
          source: args.source,
          stream: args.stream,
          eventType: args.eventType,
          amount: args.amount,
          currency: 'AUD',
          effectiveAt: args.effectiveAt,
          idempotencyKey: args.idempotencyKey,
          metadata: args.metadata as Prisma.InputJsonValue,
        },
      });
      await publishWsEvent(
        withPartnerLabel({
          type: 'revenue.event',
          at: new Date().toISOString(),
          partnerId: args.partnerId,
          stream: args.stream,
          eventType: args.eventType,
          amount: args.amount.toString(),
        }),
      );
      await writeAuditLog({
        action: 'REVENUE_EVENT_RECORDED',
        resourceType: 'revenue_event',
        resourceId: args.idempotencyKey,
        metadata: { stream: args.stream, type: args.eventType, amount: args.amount.toString() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Already recorded — idempotency holds.
        return;
      }
      throw err;
    }
  }
}
