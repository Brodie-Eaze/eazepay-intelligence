/**
 * Aurean AI drain handlers (GAP-103).
 *
 * Called by the webhook worker for jobs with `source: AUREAN_AI`. Mirrors
 * the EazePayApp pattern: resolve org via the WebhookEvent row, wrap the
 * drain in withTenantSession so the runtime role sees the GUC, branch
 * per event-type.
 *
 * Org resolution: Aurean AI events arrive into a fixed org (`aurean-ai`
 * slug). Unlike EazePay App's multi-brand mapping, there's only one
 * tenant here — so the WebhookEvent.orgId is set to the aurean-ai org
 * at ingest time and the drain trusts it.
 */
import { Prisma, RevenueEventType, RevenueStream, WebhookSource } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getEnv } from '../../../config/env.js';
import { getLogger } from '../../../config/logger.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { publishWsEvent, withPartnerLabel } from '../../../shared/utils/ws-publisher.js';
import { withTenantSession } from '../../../shared/tenant/tenant-context.js';
import { AUREAN_AI_EVENT_TYPES, type AureanAiEventType } from './event-types.js';
import type { AureanAiEventEnvelope } from './envelope.schema.js';
import {
  InferenceCompletedSchema,
  ModelDeployedSchema,
  RevenueAccruedSchema,
  ScorePublishedSchema,
} from './envelope.schema.js';

interface AureanAiJob {
  webhookEventId: string;
  envelope: AureanAiEventEnvelope;
}

export class AureanAiProcessor {
  constructor(private readonly prisma: PrismaClient) {}

  async process(job: AureanAiJob): Promise<void> {
    const log = getLogger();
    const env = job.envelope;
    const knownType = (AUREAN_AI_EVENT_TYPES as readonly string[]).includes(env.eventType);
    if (!knownType) {
      log.warn(
        {
          errorId: 'aurean_ai.unknown_event_type',
          webhookEventId: job.webhookEventId,
          eventType: env.eventType,
        },
        'aurean_ai.unknown_event_type',
      );
      await writeAuditLog({
        action: 'WEBHOOK_FAILED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: { source: 'AUREAN_AI', reason: 'unknown_event_type', eventType: env.eventType },
      });
      return;
    }
    const evt = await this.prisma.webhookEvent.findUnique({
      where: { id: job.webhookEventId },
      select: { orgId: true },
    });
    if (!evt) {
      log.warn({ webhookEventId: job.webhookEventId }, 'aurean_ai.webhook_event_not_found');
      return;
    }
    await withTenantSession(this.prisma, { orgId: evt.orgId }, async (tx) => {
      try {
        switch (env.eventType as AureanAiEventType) {
          case 'inference.completed':
            await this.handleInferenceCompleted(job, tx as unknown as PrismaClient);
            return;
          case 'score.published':
            await this.handleScorePublished(job, evt.orgId, tx as unknown as PrismaClient);
            return;
          case 'revenue.accrued':
            await this.handleRevenueAccrued(job, evt.orgId, tx as unknown as PrismaClient);
            return;
          case 'model.deployed':
            await this.handleModelDeployed(job);
            return;
        }
      } catch (err) {
        if (err instanceof z.ZodError) {
          log.error(
            {
              errorId: 'aurean_ai.invalid_payload',
              webhookEventId: job.webhookEventId,
              eventType: env.eventType,
              issues: err.issues.slice(0, 5),
            },
            'aurean_ai.invalid_payload',
          );
          await writeAuditLog({
            action: 'WEBHOOK_FAILED',
            resourceType: 'webhook_event',
            resourceId: job.webhookEventId,
            metadata: {
              source: 'AUREAN_AI',
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

  // Inference + score are observability events — we log them but don't
  // currently persist to a dedicated table. Once dashboards demand the
  // history, add an `aurean_inference_runs` model and write rows here.

  private async handleInferenceCompleted(job: AureanAiJob, _db: PrismaClient): Promise<void> {
    const data = InferenceCompletedSchema.parse(job.envelope.data);
    getLogger().info(
      {
        runId: data.runId,
        modelVersion: data.modelVersion,
        latencyMs: data.latencyMs,
        recordCount: data.recordCount,
      },
      'aurean_ai.inference.completed',
    );
  }

  private async handleScorePublished(
    job: AureanAiJob,
    orgId: string,
    _db: PrismaClient,
  ): Promise<void> {
    const data = ScorePublishedSchema.parse(job.envelope.data);
    // Broadcast a redacted score event so the dashboard live-tail picks
    // it up. The score itself is not persisted yet — Aurean owns history.
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'aurean_ai.score_published',
        at: new Date().toISOString(),
        partnerId: 'aurean-ai',
        modelVersion: data.modelVersion,
        riskBand: data.riskScore < 0.33 ? 'LOW' : data.riskScore < 0.66 ? 'MED' : 'HIGH',
      }),
    );
  }

  private async handleRevenueAccrued(
    job: AureanAiJob,
    orgId: string,
    db: PrismaClient,
  ): Promise<void> {
    const data = RevenueAccruedSchema.parse(job.envelope.data);
    const partner = await db.partner.findFirst({
      where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
      select: { id: true },
    });
    if (!partner) {
      // Don't blackhole — quarantine the WebhookEvent so operators can
      // create the partner and replay. Same pattern as EazePay App.
      await db.webhookEvent.update({
        where: { id: job.webhookEventId },
        data: {
          status: 'QUARANTINED',
          processingError: 'aurean_ai.quarantine: unknown_partner',
        },
      });
      await writeAuditLog({
        action: 'INGESTION_REJECTED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: {
          source: 'AUREAN_AI',
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
          source: WebhookSource.AUREAN_AI,
          stream: RevenueStream.AUREAN_AI,
          eventType: this.mapEventType(data.eventType),
          amount: new Prisma.Decimal(data.amount),
          currency: (data.currency ?? getEnv().DEFAULT_CURRENCY).toUpperCase(),
          effectiveAt: new Date(data.effectiveAt),
          idempotencyKey: `aurean-ai:rev:${data.externalEventId}`,
          metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      await writeAuditLog({
        action: 'REVENUE_EVENT_RECORDED',
        resourceType: 'revenue_event',
        resourceId: `aurean-ai:rev:${data.externalEventId}`,
        metadata: { stream: 'AUREAN_AI', type: data.eventType, amount: data.amount },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Already recorded — idempotent.
        return;
      }
      throw err;
    }
  }

  private async handleModelDeployed(job: AureanAiJob): Promise<void> {
    const data = ModelDeployedSchema.parse(job.envelope.data);
    // Audit-only — model deploys are operational events for the audit
    // trail, not a financial mutation.
    await writeAuditLog({
      action: 'PLATFORM_DEK_ROTATED', // reuse existing operational action
      resourceType: 'aurean_ai.model',
      resourceId: data.modelVersion,
      metadata: {
        previousModelVersion: data.previousModelVersion,
        changeSummary: data.changeSummary,
        deployedAt: data.deployedAt,
        webhookEventId: job.webhookEventId,
      },
    });
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
