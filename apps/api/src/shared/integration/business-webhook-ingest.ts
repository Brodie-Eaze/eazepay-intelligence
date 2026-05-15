/**
 * Shared business-webhook ingest helper.
 *
 * GAP-100 / 103 / 104 / 105 all follow the same pattern:
 *   1. Validate signature headers (sig, ts, idempotency-key, event-id,
 *      event-type) presence.
 *   2. Constant-time HMAC over `${ts}.${rawBody}` with the source's secret.
 *   3. Two-layer idempotency: Redis SETNX hot path → Postgres unique
 *      (orgId, source, key) cold fallback.
 *   4. Resolve the source's org via its slug.
 *   5. Persist WebhookEvent + emit OutboxEvent in ONE transaction.
 *   6. Reply 202 with persisted: true.
 *
 * Keeping it in one helper means future business sinks (e.g. micamp-
 * processing native webhooks) plug in without re-implementing HMAC or
 * idempotency. Each source provides:
 *   - WebhookSource enum value
 *   - Env var holding the HMAC secret
 *   - The org slug to resolve into orgId
 *   - The envelope Zod schema
 *   - The "known event-type" predicate
 *   - The Fastify route path
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebhookSource } from '@prisma/client';
import { type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { errors } from '../errors/app-error.js';
import { getLogger } from '../../config/logger.js';
import { writeAuditLog } from '../middleware/audit-log.middleware.js';
import { webhookRateLimit } from '../middleware/rate-limit-tiers.js';
import { appendToOutbox } from '../utils/outbox.js';

const TS_HEADER = 'x-eazepay-timestamp';
const KEY_HEADER = 'idempotency-key';
const EVENT_ID_HEADER = 'x-eazepay-event-id';
const EVENT_TYPE_HEADER = 'x-eazepay-event-type';
const TOLERANCE_SECONDS = 300;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

function firstHeader(req: FastifyRequest, name: string): string | null {
  const h = req.headers[name];
  if (!h) return null;
  if (Array.isArray(h)) return h[0] ?? null;
  return h;
}

function stripSha256Prefix(sig: string): string {
  return sig.startsWith('sha256=') ? sig.slice(7) : sig;
}

function verifySignature(
  rawBody: string,
  ts: string,
  providedHex: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  const provided = Buffer.from(providedHex, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export interface BusinessWebhookConfig<Envelope> {
  /** Fastify route path, e.g. `/integration/aurean-ai/events`. */
  routePath: string;
  /** `WebhookSource` enum value. */
  source: WebhookSource;
  /** Org slug the source posts under (e.g. `aurean-ai`). */
  orgSlug: string;
  /** Resolver for the HMAC secret. Returns undefined → 503-style early reject. */
  getSecret: () => string | undefined;
  /** Header names this source uses for the signature (Stripe-style: sha256=<hex>). */
  signatureHeaders: readonly string[];
  /** Zod schema for the envelope. */
  envelopeSchema: z.ZodType<Envelope>;
  /** Predicate distinguishing known event-types (advisory; route still ingests unknowns and lets drain decide). */
  isKnownEventType: (s: string) => boolean;
  /** Stable label for the source on the audit log. */
  auditTag: string;
}

export async function registerBusinessWebhookIngest<
  Envelope extends { eventId: string; eventType: string },
>(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis: Redis,
  cfg: BusinessWebhookConfig<Envelope>,
): Promise<void> {
  app.post(cfg.routePath, { config: webhookRateLimit() }, async (req, reply) => {
    const log = getLogger();
    // ARCH-1 (Wave C critic): the original implementation returned a
    // single `invalidSignature` for every rejection path. At 3am the
    // operator cannot tell whether the secret env var is missing, the
    // org row was never provisioned, the vendor's clock skewed, or
    // the HMAC genuinely failed. Each rejection path now logs a
    // stable `errorId` while still returning the same 401 to the
    // caller (so a probing attacker can't enumerate distinct failure
    // modes from the response shape).
    const fail = (errorId: string, meta: Record<string, unknown> = {}): never => {
      log.warn({ errorId, source: cfg.source, ...meta }, `business_webhook.reject.${errorId}`);
      throw errors.invalidSignature();
    };

    const secret = cfg.getSecret();
    if (!secret) {
      return fail('secret_missing');
    }

    const ts = firstHeader(req, TS_HEADER);
    const idempotencyKey = firstHeader(req, KEY_HEADER);
    const eventIdHeader = firstHeader(req, EVENT_ID_HEADER);
    const eventTypeHeader = firstHeader(req, EVENT_TYPE_HEADER);

    let sig: string | null = null;
    for (const name of cfg.signatureHeaders) {
      const v = firstHeader(req, name);
      if (v) {
        sig = stripSha256Prefix(v);
        break;
      }
    }
    if (!sig || !ts || !idempotencyKey || !eventIdHeader || !eventTypeHeader) {
      return fail('missing_headers');
    }
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return fail('malformed_idempotency_key');
    }

    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) return fail('malformed_timestamp');
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (skew > TOLERANCE_SECONDS) return fail('clock_skew_exceeded', { skew });

    const rawBody = req.rawBody;
    if (rawBody == null) {
      return fail('raw_body_missing');
    }
    // Fastify's rawBody is registered as `string` (see server.ts content-type
    // parser), so no Buffer coercion needed. Defensive cast preserves the
    // contract if a future refactor switches the parser to Buffer mode.
    const rawString = typeof rawBody === 'string' ? rawBody : (rawBody as Buffer).toString('utf8');
    if (!verifySignature(rawString, ts, sig, secret)) {
      return fail('hmac_mismatch');
    }

    const parsed = cfg.envelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      // SEC-206: don't echo Zod issues to the caller — they leak field
      // shape + regex sources + unknown-key lists. Log the issues server-
      // side under a stable errorId so on-call still has the detail.
      log.warn(
        {
          errorId: 'business_webhook.invalid_envelope',
          source: cfg.source,
          issues: parsed.error.issues.slice(0, 5),
        },
        'business_webhook.invalid_envelope',
      );
      reply.status(400);
      return { accepted: false, reason: 'invalid_envelope' };
    }
    const env_ = parsed.data;
    if (env_.eventId !== eventIdHeader || env_.eventType !== eventTypeHeader) {
      return fail('header_body_mismatch');
    }

    const org = await prisma.organization.findUnique({
      where: { slug: cfg.orgSlug },
      select: { id: true, deletedAt: true },
    });
    if (!org || org.deletedAt) {
      // Misconfigured: source provisioned but the receiving org isn't
      // in the DB. Same fail-closed posture as a missing secret.
      return fail('org_missing', { slug: cfg.orgSlug });
    }
    const orgId = org.id;

    const cacheKey = `idem:${cfg.source}:${idempotencyKey}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const c = JSON.parse(cached) as { status: number; body: unknown };
      reply.status(c.status);
      return c.body;
    }

    const prior = await prisma.webhookEvent.findUnique({
      where: {
        orgId_source_idempotencyKey: { orgId, source: cfg.source, idempotencyKey },
      },
    });
    if (prior) {
      const body = { accepted: true, eventId: prior.id, replayed: true, persisted: true };
      await redis.setex(cacheKey, 86_400, JSON.stringify({ status: 202, body }));
      reply.status(202);
      return body;
    }

    const webhookEventId = uuidv7();
    await prisma.$transaction(async (tx) => {
      await tx.webhookEvent.create({
        data: {
          id: webhookEventId,
          orgId,
          source: cfg.source,
          eventType: env_.eventType,
          idempotencyKey,
          signatureValid: true,
          payload: req.body as object,
        },
      });
      await appendToOutbox(tx, {
        orgId,
        kind: 'WEBHOOK_INBOUND',
        payload: {
          webhookEventId,
          source: cfg.source,
          eventType: env_.eventType,
          idempotencyKey,
          envelope: env_,
        },
        refType: 'webhook_event',
        refId: webhookEventId,
      });
    });

    await writeAuditLog({
      req,
      userId: null,
      action: 'WEBHOOK_RECEIVED',
      resourceType: 'webhook_event',
      resourceId: webhookEventId,
      orgId,
      metadata: { source: cfg.auditTag, eventType: env_.eventType, idempotencyKey },
    });

    const body = {
      accepted: true,
      eventId: webhookEventId,
      eventType: env_.eventType,
      knownEventType: cfg.isKnownEventType(env_.eventType),
      idempotencyKey,
      persisted: true,
    };
    await redis.setex(cacheKey, 86_400, JSON.stringify({ status: 202, body }));
    reply.status(202);
    return body;
  });
}
