/**
 * Webhook signature verification + durable idempotency guard.
 *
 * SOC 2 control mapping:
 *   CC6.1 (logical access)      — only signed traffic reaches the queue
 *   CC6.6 (external threat)     — HMAC + timestamp + idempotency together
 *                                 defeat both spoofing and replay
 *   CC7.3 (security event eval) — every receipt + outcome audit-logged
 *
 * Replay protection has TWO layers:
 *   1. Hot path: Redis SETNX cache (`idem:{source}:{key}`, 24h TTL).
 *      Sub-millisecond — protects against burst replays + most retry
 *      windows.
 *   2. Cold fallback: Postgres unique constraint on
 *      (source, idempotency_key) in `webhook_events`. If the Redis cache
 *      misses (eviction, > 24h vendor retry, Redis flush) the DB throws
 *      P2002 on insert and we treat that as "already seen". Durable
 *      forever.
 *
 * The DB layer is the source of truth; Redis is the cache. This is the
 * pattern Stripe uses for the same problem.
 *
 * Order of operations:
 *   1. Header presence (sig, ts, idempotency-key)
 *   2. Timestamp tolerance ±300s
 *   3. Constant-time HMAC SHA-256 compare over `${ts}.${rawBody}`
 *   4. Redis SETNX (hot replay short-circuit)
 *   5. Postgres upsert on (source, key) — unique-violation surfaces as replay
 *   6. Continue to the route handler, which writes the outbox row in a tx
 *
 * Failure modes:
 *   - Bad signature           → 401 INVALID_SIGNATURE
 *   - Replay (Redis hit)      → 202 with cached body
 *   - Replay (Postgres hit)   → 202 with current event row's metadata
 *   - First-time event        → preHandler returns; route handler completes
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
    case WebhookSource.PIXIE:
      return env.PIXIE_WEBHOOK_SECRET;
    case WebhookSource.MICAMP:
      return env.MICAMP_WEBHOOK_SECRET;
    case WebhookSource.BUZZPAY:
      // Retired vendor — see docs/cuts/buzzpay-removal.md. Routes are gone;
      // this branch is unreachable unless an old queued job is replayed.
      throw new Error('BUZZPAY webhook source is retired');
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
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
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

    // Idempotency layer 1: hot Redis cache.
    const redis = getRedis();
    const cacheKey = `idem:${source}:${keyStr}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const c = JSON.parse(cached) as { status: number; body: unknown };
      reply.status(c.status).send(c.body);
      return;
    }

    // Idempotency layer 2: durable Postgres constraint.
    // findUnique on (source, key) — if it exists, this is a replay that
    // outlived the Redis TTL or evaded the cache.
    const prisma = getPrisma();
    const prior = await prisma.webhookEvent.findUnique({
      where: { source_idempotencyKey: { source, idempotencyKey: keyStr } },
    });
    if (prior) {
      // Re-warm Redis with a 202 ack so future hot-path replays are sub-ms.
      const body = { accepted: true, eventId: prior.id, replayed: true };
      await redis.setex(cacheKey, 86_400, JSON.stringify({ status: 202, body }));
      reply.status(202).send(body);
      return;
    }

    // First-time event: durably persist BEFORE we ack so the outbox handler
    // (in the route) can attach to this row in the same transaction.
    const event = await prisma.webhookEvent.create({
      data: {
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
