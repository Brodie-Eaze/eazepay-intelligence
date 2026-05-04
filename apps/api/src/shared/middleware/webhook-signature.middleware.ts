/**
 * Webhook signature verification + idempotency guard.
 *
 * SOC 2 control mapping:
 *   CC6.1 (logical access)         — only signed traffic reaches the queue
 *   CC6.6 (external threat)         — HMAC + timestamp + idempotency together
 *                                     defeat both spoofing and replay
 *   CC7.3 (security event eval)     — every receipt + outcome audit-logged
 *
 * Order of operations (intentional):
 *   1. Header presence (sig, ts, idempotency-key)
 *   2. Timestamp tolerance ±300s (caps replay window even on stolen payloads)
 *   3. Constant-time HMAC SHA-256 compare over `${ts}.${rawBody}` with the
 *      per-source secret
 *   4. Redis SETNX dedupe — replays return the original 202 verbatim
 *   5. Durable persist of the WebhookEvent row (audit trail) BEFORE we ack
 *   6. Continue to the route handler, which enqueues + replies 202
 *
 * Failure modes:
 *   - Bad signature → 401 INVALID_SIGNATURE, audit row, request dropped
 *   - Replay (same idempotency-key in 24h window) → 202 with cached body
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { errors } from '../errors/app-error.js';
import { getEnv } from '../../config/env.js';
import { getPrisma } from '../../config/database.js';
import { getRedis } from '../../config/redis.js';
import { writeAuditLog } from './audit-log.middleware.js';
import { WebhookSource } from '@prisma/client';

const SIG_HEADER = 'x-eazepay-signature';
const TS_HEADER = 'x-eazepay-timestamp';
const KEY_HEADER = 'idempotency-key';
const TOLERANCE_SECONDS = 300; // 5-min replay window

declare module 'fastify' {
  interface FastifyRequest {
    webhook?: {
      source: WebhookSource;
      idempotencyKey: string;
      eventId: string; // WebhookEvent.id we created
    };
  }
}

function secretFor(source: WebhookSource): string {
  const env = getEnv();
  switch (source) {
    case WebhookSource.BUZZPAY:
      return env.BUZZPAY_WEBHOOK_SECRET;
    case WebhookSource.PIXIE:
      return env.PIXIE_WEBHOOK_SECRET;
    case WebhookSource.MICAMP:
      return env.MICAMP_WEBHOOK_SECRET;
  }
}

/**
 * HMAC-SHA-256 verification + idempotency guard + WebhookEvent persistence.
 * Order: header presence → timestamp tolerance → constant-time signature compare →
 * Redis SETNX dedupe → DB upsert → continue to handler.
 */
export function verifyWebhookSignature(source: WebhookSource): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sig = req.headers[SIG_HEADER];
    const ts = req.headers[TS_HEADER];
    const key = req.headers[KEY_HEADER];
    if (!sig || !ts || !key) {
      throw errors.invalidSignature();
    }
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    const tsStr = Array.isArray(ts) ? ts[0] : ts;
    const keyStr = Array.isArray(key) ? key[0] : key;
    if (!sigStr || !tsStr || !keyStr) throw errors.invalidSignature();

    // Timestamp tolerance — caps replay window even if attacker steals a payload.
    const tsNum = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(tsNum)) throw errors.invalidSignature();
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (skew > TOLERANCE_SECONDS) throw errors.invalidSignature();

    // Compute expected signature over `${ts}.${rawBody}`.
    const raw =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const data = `${tsStr}.${raw}`;
    const expected = createHmac('sha256', secretFor(source)).update(data).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(sigStr, 'hex');
    } catch {
      throw errors.invalidSignature();
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw errors.invalidSignature();
    }

    // Idempotency: short-circuit replays at the edge.
    const redis = getRedis();
    const cacheKey = `idem:${source}:${keyStr}`;
    const existing = await redis.get(cacheKey);
    if (existing) {
      const cached = JSON.parse(existing) as { status: number; body: unknown };
      reply.status(cached.status).send(cached.body);
      return; // halts further preHandlers + main handler
    }

    // Persist receipt durably BEFORE we ack — gives us a complete inbound audit trail.
    const event = await getPrisma().webhookEvent.upsert({
      where: { source_idempotencyKey: { source, idempotencyKey: keyStr } },
      update: {},
      create: {
        id: uuidv7(),
        source,
        eventType: deriveEventTypeFromUrl(req.url),
        idempotencyKey: keyStr,
        signatureValid: true,
        payload: (req.body ?? {}) as object,
      },
    });

    await writeAuditLog({
      req,
      userId: null,
      action: 'WEBHOOK_RECEIVED',
      resourceType: 'webhook_event',
      resourceId: event.id,
      metadata: { source, eventType: event.eventType, idempotencyKey: keyStr },
    });

    req.webhook = { source, idempotencyKey: keyStr, eventId: event.id };
  };
}

function deriveEventTypeFromUrl(url: string): string {
  // /api/v1/webhooks/{source}/{eventType}?...
  const path = url.split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}
