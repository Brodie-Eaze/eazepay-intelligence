import { Prisma, RevenueEventType, RevenueStream, WebhookSource } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { getLogger } from '../../config/logger.js';
import { encryptPII } from '../../shared/utils/encryption.js';
import { errors } from '../../shared/errors/app-error.js';
import { publishWsEvent, withPartnerLabel } from '../../shared/utils/ws-publisher.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import {
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
        case WebhookSource.PIXIE:
          await this.handlePixie(job);
          break;
        case WebhookSource.MICAMP:
          await this.handleMicamp(job);
          break;
        case WebhookSource.BUZZPAY:
          // Retired vendor — see docs/cuts/buzzpay-removal.md. Routes are
          // gone; this branch only fires if an old queued job is replayed.
          // SF-017: log + audit the drop instead of silently swallowing so
          // a misconfiguration (someone re-enabling BUZZPAY ingress) is
          // visible in the metric stream.
          getLogger().warn(
            {
              webhookEventId: job.webhookEventId,
              idempotencyKey: job.idempotencyKey,
              errorId: 'webhook.buzzpay.drop_retired',
            },
            'webhook.buzzpay.drop_retired',
          );
          await writeAuditLog({
            action: 'WEBHOOK_FAILED',
            resourceType: 'webhook_event',
            resourceId: job.webhookEventId,
            metadata: { source: 'BUZZPAY', reason: 'retired_vendor', eventType: job.eventType },
          });
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
  //
  // Retired vendor. The route group (/webhooks/buzzpay/*), the four Zod
  // schemas, the per-event handlers, and the `handleBuzzpay` switch branch
  // are all gone. See docs/cuts/buzzpay-removal.md.
  //
  // The Prisma enum values `WebhookSource.BUZZPAY` and `RevenueStream.BUZZPAY`
  // remain on the schema because existing dev rows may carry them; the Phase
  // C migration drops them (and the Partner.buzzpayRevSharePct column +
  // RevenueAggregation.buzzpayRevshareTotal column) once a backfill plan is
  // in place. Until then, the switch arm in `process()` swallows replays.

  // ─── Pixie ──────────────────────────────────────────────────────────────

  private async handlePixie(job: ProcessJobInput): Promise<void> {
    if (job.eventType !== 'usage') {
      throw errors.badRequest(`Unknown Pixie event type: ${job.eventType}`);
    }
    const data = PixieUsageWebhookSchema.parse(job.payload);
    const env = getEnv();
    const date = new Date(data.date);
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
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
        where: {
          periodStart_partnerId_period: {
            periodStart: dayStart,
            partnerId: partner.id,
            period: 'DAILY',
          },
        },
        create: {
          orgId: partner.orgId,
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
        partner.orgId,
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
          ...(data.currency ? { currency: data.currency } : {}),
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
          ...(data.currency ? { currency: data.currency } : {}),
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
    /**
     * ISO-4217 currency for this event. Optional — vendors that don't
     * emit one fall back to the platform's DEFAULT_CURRENCY env var.
     * Was previously hardcoded to AUD; that hardcode meant every USD
     * partner was relabelled at ingestion. Multi-currency now respected.
     */
    currency?: string;
  }): Promise<void> {
    try {
      const currency = (args.currency ?? getEnv().DEFAULT_CURRENCY).toUpperCase();
      // Phase 1 retrofit: revenue_events now carry org_id. Resolve from the
      // partner row (the unique (orgId, externalId) means there is exactly
      // one partner per id).
      const partner = await this.prisma.partner.findUnique({
        where: { id: args.partnerId },
        select: { orgId: true },
      });
      if (!partner) {
        throw new Error(`recordRevenue: partner ${args.partnerId} not found`);
      }
      await this.prisma.revenueEvent.create({
        data: {
          orgId: partner.orgId,
          partnerId: args.partnerId,
          lenderDecisionId: args.lenderDecisionId ?? null,
          source: args.source,
          stream: args.stream,
          eventType: args.eventType,
          amount: args.amount,
          currency,
          effectiveAt: args.effectiveAt,
          idempotencyKey: args.idempotencyKey,
          metadata: args.metadata as Prisma.InputJsonValue,
        },
      });
      await publishWsEvent(
        partner.orgId,
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
