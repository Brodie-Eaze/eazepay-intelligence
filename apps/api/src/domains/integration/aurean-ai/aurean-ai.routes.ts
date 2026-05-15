/**
 * POST /api/v1/integration/aurean-ai/events  (GAP-103)
 *
 * HMAC-signed inbound webhook from the Aurean AI inference platform.
 * Delegates the full ingest pipeline (HMAC verify → 2-layer idempotency
 * → org resolution → WebhookEvent + OutboxEvent in a tx) to the shared
 * business-webhook-ingest helper. Drain is in aurean-ai.service.ts.
 */
import type { FastifyInstance } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { getEnv } from '../../../config/env.js';
import { getPrisma } from '../../../config/database.js';
import { getRedis } from '../../../config/redis.js';
import { registerBusinessWebhookIngest } from '../../../shared/integration/business-webhook-ingest.js';
import { AureanAiEventEnvelopeSchema } from './envelope.schema.js';
import { isKnownAureanAiEventType } from './event-types.js';

export function isAureanAiEnabled(): boolean {
  return Boolean(getEnv().AUREAN_AI_WEBHOOK_SECRET);
}

export async function registerAureanAiIntegrationRoutes(app: FastifyInstance): Promise<void> {
  await registerBusinessWebhookIngest(app, getPrisma(), getRedis(), {
    routePath: '/integration/aurean-ai/events',
    source: WebhookSource.AUREAN_AI,
    orgSlug: 'aurean-ai',
    getSecret: () => getEnv().AUREAN_AI_WEBHOOK_SECRET,
    signatureHeaders: ['x-eazepay-signature', 'x-aurean-signature'],
    envelopeSchema: AureanAiEventEnvelopeSchema,
    isKnownEventType: isKnownAureanAiEventType,
    auditTag: 'AUREAN_AI',
  });
}
