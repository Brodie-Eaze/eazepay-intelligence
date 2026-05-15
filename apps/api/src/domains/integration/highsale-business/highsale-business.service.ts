/**
 * HighSale business-event drain handlers (GAP-105).
 *
 * Mirrors the EazePayApp / AureanAi / AureanRecruitment pattern. Org
 * resolution: the HighSale business has its own org (`highsale` slug);
 * WebhookEvent.orgId is set at ingest and the drain trusts it.
 */
import { Prisma, RevenueEventType, RevenueStream, WebhookSource } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getLogger } from '../../../config/logger.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { publishWsEvent, withPartnerLabel } from '../../../shared/utils/ws-publisher.js';
import { withTenantSession } from '../../../shared/tenant/tenant-context.js';
import { HIGHSALE_BUSINESS_EVENT_TYPES, type HighSaleBusinessEventType } from './event-types.js';
import {
  InquirySubmittedSchema,
  RevenueRecordedSchema,
  RiskBandAssignedSchema,
  SnapshotGeneratedSchema,
  type HighSaleBusinessEventEnvelope,
} from './envelope.schema.js';

interface HighSaleBusinessJob {
  webhookEventId: string;
  envelope: HighSaleBusinessEventEnvelope;
}

export class HighSaleBusinessProcessor {
  constructor(private readonly prisma: PrismaClient) {}

  async process(job: HighSaleBusinessJob): Promise<void> {
    const log = getLogger();
    const env = job.envelope;
    if (!(HIGHSALE_BUSINESS_EVENT_TYPES as readonly string[]).includes(env.eventType)) {
      log.warn(
        {
          errorId: 'highsale_business.unknown_event_type',
          webhookEventId: job.webhookEventId,
          eventType: env.eventType,
        },
        'highsale_business.unknown_event_type',
      );
      await writeAuditLog({
        action: 'WEBHOOK_FAILED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: {
          source: 'HIGHSALE',
          reason: 'unknown_event_type',
          eventType: env.eventType,
        },
      });
      return;
    }
    const evt = await this.prisma.webhookEvent.findUnique({
      where: { id: job.webhookEventId },
      select: { orgId: true },
    });
    if (!evt) {
      log.warn({ webhookEventId: job.webhookEventId }, 'highsale_business.webhook_event_not_found');
      return;
    }
    await withTenantSession(this.prisma, { orgId: evt.orgId }, async (tx) => {
      try {
        switch (env.eventType as HighSaleBusinessEventType) {
          case 'inquiry.submitted':
            await this.handleInquirySubmitted(job, evt.orgId);
            return;
          case 'risk_band.assigned':
            await this.handleRiskBandAssigned(job, evt.orgId);
            return;
          case 'snapshot.generated':
            await this.handleSnapshotGenerated(job, evt.orgId);
            return;
          case 'revenue.recorded':
            await this.handleRevenueRecorded(job, evt.orgId, tx as unknown as PrismaClient);
            return;
        }
      } catch (err) {
        if (err instanceof z.ZodError) {
          log.error(
            {
              errorId: 'highsale_business.invalid_payload',
              webhookEventId: job.webhookEventId,
              eventType: env.eventType,
              issues: err.issues.slice(0, 5),
            },
            'highsale_business.invalid_payload',
          );
          await writeAuditLog({
            action: 'WEBHOOK_FAILED',
            resourceType: 'webhook_event',
            resourceId: job.webhookEventId,
            metadata: {
              source: 'HIGHSALE',
              reason: 'invalid_payload',
              eventType: env.eventType,
            },
          });
          return;
        }
        throw err;
      }
    });
  }

  private async handleInquirySubmitted(job: HighSaleBusinessJob, orgId: string): Promise<void> {
    const data = InquirySubmittedSchema.parse(job.envelope.data);
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'highsale.inquiry.submitted',
        at: new Date().toISOString(),
        partnerId: 'highsale',
        vertical: data.vertical,
      }),
    );
  }

  private async handleRiskBandAssigned(job: HighSaleBusinessJob, orgId: string): Promise<void> {
    const data = RiskBandAssignedSchema.parse(job.envelope.data);
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'highsale.risk_band.assigned',
        at: new Date().toISOString(),
        partnerId: 'highsale',
        riskBand: data.riskBand,
      }),
    );
  }

  private async handleSnapshotGenerated(job: HighSaleBusinessJob, orgId: string): Promise<void> {
    const data = SnapshotGeneratedSchema.parse(job.envelope.data);
    // The actual snapshot lands via /integration/highsale/snapshots — this
    // event is a control-plane heartbeat we log for the operations view.
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'highsale.snapshot.generated',
        at: new Date().toISOString(),
        partnerId: 'highsale',
        highsaleTransactionId: data.highsaleTransactionId,
        vertical: data.vertical,
      }),
    );
  }

  private async handleRevenueRecorded(
    job: HighSaleBusinessJob,
    orgId: string,
    db: PrismaClient,
  ): Promise<void> {
    const data = RevenueRecordedSchema.parse(job.envelope.data);
    const partner = await db.partner.findFirst({
      where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
      select: { id: true },
    });
    if (!partner) {
      await db.webhookEvent.update({
        where: { id: job.webhookEventId },
        data: {
          status: 'QUARANTINED',
          processingError: 'highsale_business.quarantine: unknown_partner',
        },
      });
      await writeAuditLog({
        action: 'INGESTION_REJECTED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: {
          source: 'HIGHSALE',
          reason: 'unknown_partner',
          partnerExternalId: data.partnerExternalId,
        },
      });
      return;
    }
    try {
      await db.revenueEvent.create({
        data: {
          orgId,
          partnerId: partner.id,
          source: WebhookSource.HIGHSALE,
          stream: RevenueStream.HIGHSALE,
          eventType: this.mapEventType(data.eventType),
          amount: new Prisma.Decimal(data.amount),
          currency: data.currency.toUpperCase(),
          effectiveAt: new Date(data.effectiveAt),
          idempotencyKey: `highsale:rev:${data.externalEventId}`,
          metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return; // idempotent
      }
      throw err;
    }
  }

  private mapEventType(v: 'ACCRUAL' | 'COMMISSION' | 'REVERSAL'): RevenueEventType {
    switch (v) {
      case 'ACCRUAL':
        return RevenueEventType.ACCRUAL;
      case 'COMMISSION':
        return RevenueEventType.COMMISSION;
      case 'REVERSAL':
        return RevenueEventType.REVERSAL;
    }
  }
}
