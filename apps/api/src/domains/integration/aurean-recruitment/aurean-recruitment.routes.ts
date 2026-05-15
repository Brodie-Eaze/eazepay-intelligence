/**
 * POST /api/v1/integration/aurean-recruitment/events  (GAP-104)
 *
 * HMAC-signed inbound webhook from the Aurean Recruitment ATS.
 */
import type { FastifyInstance } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { getEnv } from '../../../config/env.js';
import { getPrisma } from '../../../config/database.js';
import { getRedis } from '../../../config/redis.js';
import { registerBusinessWebhookIngest } from '../../../shared/integration/business-webhook-ingest.js';
import { AureanRecruitmentEventEnvelopeSchema } from './envelope.schema.js';
import { isKnownAureanRecruitmentEventType } from './event-types.js';

export function isAureanRecruitmentEnabled(): boolean {
  return Boolean(getEnv().AUREAN_RECRUITMENT_WEBHOOK_SECRET);
}

export async function registerAureanRecruitmentIntegrationRoutes(
  app: FastifyInstance,
): Promise<void> {
  await registerBusinessWebhookIngest(app, getPrisma(), getRedis(), {
    routePath: '/integration/aurean-recruitment/events',
    source: WebhookSource.AUREAN_RECRUITMENT,
    orgSlug: 'aurean-recruitment',
    getSecret: () => getEnv().AUREAN_RECRUITMENT_WEBHOOK_SECRET,
    signatureHeaders: ['x-eazepay-signature', 'x-aurean-signature'],
    envelopeSchema: AureanRecruitmentEventEnvelopeSchema,
    isKnownEventType: isKnownAureanRecruitmentEventType,
    auditTag: 'AUREAN_RECRUITMENT',
  });
}
