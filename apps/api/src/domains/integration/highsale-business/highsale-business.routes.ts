/**
 * POST /api/v1/integration/highsale/events  (GAP-105)
 *
 * HMAC-signed business-event stream from HighSale. Distinct from the
 * existing /integration/highsale/snapshots route which carries the
 * credit_enrichments PII payloads — this route is for operational
 * lifecycle events (inquiry / risk-band / revenue) that drive the
 * HighSale business unit's own dashboard.
 *
 * The HMAC secret is the existing HIGHSALE_WEBHOOK_SECRET — both routes
 * are signed by the same source.
 */
import type { FastifyInstance } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { getEnv } from '../../../config/env.js';
import { getPrisma } from '../../../config/database.js';
import { getRedis } from '../../../config/redis.js';
import { registerBusinessWebhookIngest } from '../../../shared/integration/business-webhook-ingest.js';
import { HighSaleBusinessEventEnvelopeSchema } from './envelope.schema.js';
import { isKnownHighSaleBusinessEventType } from './event-types.js';

export async function registerHighSaleBusinessIntegrationRoutes(
  app: FastifyInstance,
): Promise<void> {
  await registerBusinessWebhookIngest(app, getPrisma(), getRedis(), {
    routePath: '/integration/highsale/events',
    source: WebhookSource.HIGHSALE,
    orgSlug: 'highsale',
    getSecret: () => getEnv().HIGHSALE_WEBHOOK_SECRET,
    signatureHeaders: ['x-eazepay-signature', 'x-highsale-signature'],
    envelopeSchema: HighSaleBusinessEventEnvelopeSchema,
    isKnownEventType: isKnownHighSaleBusinessEventType,
    auditTag: 'HIGHSALE',
  });
}
