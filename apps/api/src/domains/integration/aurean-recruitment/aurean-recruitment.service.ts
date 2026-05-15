/**
 * Aurean Recruitment drain handlers (GAP-104).
 *
 * Lifecycle events → revenue accruals (`commission.earned`), clawbacks
 * (`placement.rescinded`). Pipeline events are logged for KPI dashboards
 * but not persisted to dedicated tables yet — once the pipeline-funnel
 * dashboard demands history, add a `recruitment_pipeline_events` model
 * and write here.
 */
import { Prisma, RevenueEventType, RevenueStream, WebhookSource } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getLogger } from '../../../config/logger.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { publishWsEvent, withPartnerLabel } from '../../../shared/utils/ws-publisher.js';
import { withTenantSession } from '../../../shared/tenant/tenant-context.js';
import { AUREAN_RECRUITMENT_EVENT_TYPES, type AureanRecruitmentEventType } from './event-types.js';
import {
  CandidateEnteredPipelineSchema,
  CandidateStageChangedSchema,
  CommissionEarnedSchema,
  PlacementContractedSchema,
  PlacementRescindedSchema,
  type AureanRecruitmentEventEnvelope,
} from './envelope.schema.js';

interface AureanRecruitmentJob {
  webhookEventId: string;
  envelope: AureanRecruitmentEventEnvelope;
}

export class AureanRecruitmentProcessor {
  constructor(private readonly prisma: PrismaClient) {}

  async process(job: AureanRecruitmentJob): Promise<void> {
    const log = getLogger();
    const env = job.envelope;
    if (!(AUREAN_RECRUITMENT_EVENT_TYPES as readonly string[]).includes(env.eventType)) {
      log.warn(
        {
          errorId: 'aurean_recruitment.unknown_event_type',
          webhookEventId: job.webhookEventId,
          eventType: env.eventType,
        },
        'aurean_recruitment.unknown_event_type',
      );
      await writeAuditLog({
        action: 'WEBHOOK_FAILED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: {
          source: 'AUREAN_RECRUITMENT',
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
      log.warn(
        { webhookEventId: job.webhookEventId },
        'aurean_recruitment.webhook_event_not_found',
      );
      return;
    }
    await withTenantSession(this.prisma, { orgId: evt.orgId }, async (tx) => {
      try {
        switch (env.eventType as AureanRecruitmentEventType) {
          case 'candidate.entered_pipeline':
            await this.handleCandidateEntered(job, evt.orgId);
            return;
          case 'candidate.stage_changed':
            await this.handleStageChanged(job, evt.orgId);
            return;
          case 'placement.contracted':
            await this.handlePlacementContracted(job, evt.orgId);
            return;
          case 'commission.earned':
            await this.handleCommissionEarned(job, evt.orgId, tx as unknown as PrismaClient);
            return;
          case 'placement.rescinded':
            await this.handlePlacementRescinded(job, evt.orgId, tx as unknown as PrismaClient);
            return;
        }
      } catch (err) {
        if (err instanceof z.ZodError) {
          log.error(
            {
              errorId: 'aurean_recruitment.invalid_payload',
              webhookEventId: job.webhookEventId,
              eventType: env.eventType,
              issues: err.issues.slice(0, 5),
            },
            'aurean_recruitment.invalid_payload',
          );
          await writeAuditLog({
            action: 'WEBHOOK_FAILED',
            resourceType: 'webhook_event',
            resourceId: job.webhookEventId,
            metadata: {
              source: 'AUREAN_RECRUITMENT',
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

  private async handleCandidateEntered(job: AureanRecruitmentJob, orgId: string): Promise<void> {
    const data = CandidateEnteredPipelineSchema.parse(job.envelope.data);
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'aurean_recruitment.candidate.entered',
        at: new Date().toISOString(),
        partnerId: 'aurean-recruitment',
        pipelineId: data.pipelineId,
      }),
    );
  }

  private async handleStageChanged(job: AureanRecruitmentJob, orgId: string): Promise<void> {
    const data = CandidateStageChangedSchema.parse(job.envelope.data);
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'aurean_recruitment.candidate.stage_changed',
        at: new Date().toISOString(),
        partnerId: 'aurean-recruitment',
        from: data.fromStage,
        to: data.toStage,
      }),
    );
  }

  private async handlePlacementContracted(job: AureanRecruitmentJob, orgId: string): Promise<void> {
    const data = PlacementContractedSchema.parse(job.envelope.data);
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'aurean_recruitment.placement.contracted',
        at: new Date().toISOString(),
        partnerId: 'aurean-recruitment',
        placementId: data.placementId,
        annualSalary: data.annualSalary,
      }),
    );
  }

  private async handleCommissionEarned(
    job: AureanRecruitmentJob,
    orgId: string,
    db: PrismaClient,
  ): Promise<void> {
    const data = CommissionEarnedSchema.parse(job.envelope.data);
    const partner = await db.partner.findFirst({
      where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
      select: { id: true },
    });
    if (!partner) {
      await this.quarantine(db, job, 'unknown_partner', data.partnerExternalId);
      return;
    }
    try {
      await db.revenueEvent.create({
        data: {
          orgId,
          partnerId: partner.id,
          source: WebhookSource.AUREAN_RECRUITMENT,
          stream: RevenueStream.AUREAN_RECRUITMENT,
          eventType: RevenueEventType.COMMISSION,
          amount: new Prisma.Decimal(data.amount),
          currency: data.currency.toUpperCase(),
          effectiveAt: new Date(data.effectiveAt),
          idempotencyKey: `aurean-recruitment:commission:${data.externalEventId}`,
          metadata: {
            placementId: data.placementId,
            ...(data.metadata ?? {}),
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return; // idempotent
      }
      throw err;
    }
  }

  private async handlePlacementRescinded(
    job: AureanRecruitmentJob,
    orgId: string,
    db: PrismaClient,
  ): Promise<void> {
    const data = PlacementRescindedSchema.parse(job.envelope.data);
    const partner = await db.partner.findFirst({
      where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
      select: { id: true },
    });
    if (!partner) {
      await this.quarantine(db, job, 'unknown_partner', data.partnerExternalId);
      return;
    }
    try {
      await db.revenueEvent.create({
        data: {
          orgId,
          partnerId: partner.id,
          source: WebhookSource.AUREAN_RECRUITMENT,
          stream: RevenueStream.AUREAN_RECRUITMENT,
          eventType: RevenueEventType.CLAWBACK,
          amount: new Prisma.Decimal(data.clawbackAmount).neg(),
          currency: data.currency.toUpperCase(),
          effectiveAt: new Date(data.rescindedAt),
          idempotencyKey: `aurean-recruitment:rescind:${data.externalEventId}`,
          metadata: {
            placementId: data.placementId,
            reason: data.reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }
  }

  private async quarantine(
    db: PrismaClient,
    job: AureanRecruitmentJob,
    reason: string,
    partnerExternalId: string,
  ): Promise<void> {
    await db.webhookEvent.update({
      where: { id: job.webhookEventId },
      data: {
        status: 'QUARANTINED',
        processingError: `aurean_recruitment.quarantine: ${reason}`,
      },
    });
    await writeAuditLog({
      action: 'INGESTION_REJECTED',
      resourceType: 'webhook_event',
      resourceId: job.webhookEventId,
      metadata: { source: 'AUREAN_RECRUITMENT', reason, partnerExternalId },
    });
  }
}
