/**
 * POST /api/v1/integration/eazepay-app/events
 *
 * Inbound webhook from EazePay App's WebhookDispatcher. Stripe-style
 * HMAC-SHA-256 verification + idempotency + envelope validation +
 * durable persistence + outbox-mediated drain.
 *
 * Flow per request:
 *   1. Validate headers (sig, ts, idempotency-key, event-id, event-type).
 *   2. Constant-time HMAC over `${ts}.${rawBody}` with the App secret.
 *   3. Idempotency layer 1: Redis SETNX.
 *   4. Idempotency layer 2: Postgres unique (orgId, source, key) — replay
 *      returns the prior event id.
 *   5. Resolve org via brand (App's `data.brand` → org slug; unmapped
 *      brands land under the bootstrap org as QUARANTINE).
 *   6. tx { INSERT WebhookEvent; INSERT OutboxEvent(WEBHOOK_INBOUND); }
 *   7. Reply 202 with persisted: true + eventId.
 *
 * Contract: docs/integration/eazepay-app-contract.md
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { getEnv } from '../../../config/env.js';
import { getPrisma } from '../../../config/database.js';
import { getRedis } from '../../../config/redis.js';
import { errors } from '../../../shared/errors/app-error.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { webhookRateLimit } from '../../../shared/middleware/rate-limit-tiers.js';
import { appendToOutbox } from '../../../shared/utils/outbox.js';
import { getBootstrapOrgId } from '../../../shared/tenant/bootstrap-org.js';
import { EazepayAppEventEnvelopeSchema } from './envelope.schema.js';
import { isKnownEazepayAppEventType } from './event-types.js';
import { resolveBrandToOrgSlug } from './brand-org-mapping.js';

const SIG_HEADERS = ['x-eazepay-signature', 'x-eazepay-signature-placeholder'] as const;
const TS_HEADER = 'x-eazepay-timestamp';
const KEY_HEADER = 'idempotency-key';

/**
 * SEC-016: idempotency-key shape gate. Without this a signed sender could
 * SETNX multi-MB keys into Redis and balloon memory (and pollute the DB
 * unique-index too). Same regex the generic webhook middleware uses for
 * MiCamp / Pixie / etc. CWE-799 Improper Control of Interaction Frequency.
 */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const EVENT_ID_HEADER = 'x-eazepay-event-id';
const EVENT_TYPE_HEADER = 'x-eazepay-event-type';
const TOLERANCE_SECONDS = 300;

function firstHeader(req: FastifyRequest, name: string): string | null {
  const h = req.headers[name];
  if (!h) return null;
  if (Array.isArray(h)) return h[0] ?? null;
  return h;
}

/**
 * App today sends `sha256=<hex>`. Tomorrow it may emit raw hex once the
 * SecretResolver lands. Strip the prefix if present so we compare hex
 * against hex either way.
 */
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
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function registerEazepayAppIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/integration/eazepay-app/events',
    // SEC-005: webhook tier rate limit (10K/min per source IP) instead of
    // the default 1000/min per-user envelope. Matches PIXIE / MICAMP.
    { config: webhookRateLimit() },
    async (req, reply) => {
      const env = getEnv();

      // ─── Header presence ───────────────────────────────────────────────
      const ts = firstHeader(req, TS_HEADER);
      const idempotencyKey = firstHeader(req, KEY_HEADER);
      const eventIdHeader = firstHeader(req, EVENT_ID_HEADER);
      const eventTypeHeader = firstHeader(req, EVENT_TYPE_HEADER);

      let sig: string | null = null;
      for (const name of SIG_HEADERS) {
        const v = firstHeader(req, name);
        if (v) {
          sig = stripSha256Prefix(v);
          break;
        }
      }
      if (!sig || !ts || !idempotencyKey || !eventIdHeader || !eventTypeHeader) {
        throw errors.invalidSignature();
      }

      // SEC-016: reject malformed idempotency keys BEFORE any Redis/DB
      // touch. Length-capped + charset-restricted.
      if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        throw errors.badRequest('Malformed idempotency-key (16–128 chars, [A-Za-z0-9_-])');
      }

      // ─── Timestamp tolerance ───────────────────────────────────────────
      const tsNum = Number.parseInt(ts, 10);
      if (!Number.isFinite(tsNum)) throw errors.invalidSignature();
      const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
      if (skew > TOLERANCE_SECONDS) throw errors.invalidSignature();

      // ─── HMAC compare ──────────────────────────────────────────────────
      // P0 fix (SEC-004 / CR-104 / SEC-100): sign over the RAW request bytes,
      // not a re-serialised JSON form. Fastify's JSON content-type parser is
      // overridden in server.ts to retain `req.rawBody` for every JSON
      // request. JSON.stringify(req.body) reorders/normalises (whitespace,
      // numeric precision, key order, unicode escapes) and DOES NOT round-
      // trip the App dispatcher's signed bytes — meaning legitimate webhooks
      // can fail and crafted payloads can pass. Always read req.rawBody.
      const rawBody = req.rawBody;
      if (rawBody == null) {
        // Defensive: rawBody capture is wired in server.ts. If a future
        // refactor drops the content-type parser, fail closed — every
        // webhook becomes 401 until the wiring is restored.
        throw errors.invalidSignature();
      }
      if (!verifySignature(rawBody, ts, sig, env.EAZEPAY_APP_WEBHOOK_SECRET)) {
        throw errors.invalidSignature();
      }

      // ─── Envelope schema ───────────────────────────────────────────────
      const parsed = EazepayAppEventEnvelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.status(400);
        return {
          accepted: false,
          reason: 'invalid_envelope',
          issues: parsed.error.issues,
        };
      }
      const env_ = parsed.data;

      // Cross-check headers ↔ body. App's dispatcher sets both; mismatch
      // means tampering or a proxy stripping headers — fail closed.
      if (env_.eventId !== eventIdHeader || env_.eventType !== eventTypeHeader) {
        throw errors.invalidSignature();
      }

      // ─── Resolve org via brand mapping ─────────────────────────────────
      // The envelope's `data.brand` field tells us which Intelligence org
      // owns this event. Unmapped brands (e.g. `direct`) land under the
      // bootstrap org so the WebhookEvent row is still durable + replayable.
      const brand = String(env_.data.brand ?? '');
      const prisma = getPrisma();
      const redis = getRedis();
      let orgId: string;
      if (brand) {
        const resolution = resolveBrandToOrgSlug(brand);
        if (resolution.orgSlug) {
          const org = await prisma.organization.findUnique({
            where: { slug: resolution.orgSlug },
            select: { id: true, deletedAt: true },
          });
          orgId = org && !org.deletedAt ? org.id : await getBootstrapOrgId(prisma);
        } else {
          orgId = await getBootstrapOrgId(prisma);
        }
      } else {
        orgId = await getBootstrapOrgId(prisma);
      }

      // ─── Idempotency layer 1: Redis SETNX ──────────────────────────────
      const cacheKey = `idem:EAZEPAY_APP:${idempotencyKey}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        const c = JSON.parse(cached) as { status: number; body: unknown };
        reply.status(c.status);
        return c.body;
      }

      // ─── Idempotency layer 2: Postgres unique (orgId, source, key) ─────
      const prior = await prisma.webhookEvent.findUnique({
        where: {
          orgId_source_idempotencyKey: {
            orgId,
            source: WebhookSource.EAZEPAY_APP,
            idempotencyKey,
          },
        },
      });
      if (prior) {
        const body = { accepted: true, eventId: prior.id, replayed: true, persisted: true };
        await redis.setex(cacheKey, 86_400, JSON.stringify({ status: 202, body }));
        reply.status(202);
        return body;
      }

      // ─── Persist + emit outbox in ONE transaction ──────────────────────
      const webhookEventId = uuidv7();
      await prisma.$transaction(async (tx) => {
        await tx.webhookEvent.create({
          data: {
            id: webhookEventId,
            orgId,
            source: WebhookSource.EAZEPAY_APP,
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
            source: WebhookSource.EAZEPAY_APP,
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
        metadata: {
          source: 'EAZEPAY_APP',
          eventType: env_.eventType,
          idempotencyKey,
          brand: brand || null,
        },
      });

      // Warm the Redis cache so subsequent replays inside 24h short-circuit.
      const body = {
        accepted: true,
        eventId: webhookEventId,
        eventType: env_.eventType,
        knownEventType: isKnownEazepayAppEventType(env_.eventType),
        idempotencyKey,
        persisted: true,
      };
      await redis.setex(cacheKey, 86_400, JSON.stringify({ status: 202, body }));
      reply.status(202);
      return body;
    },
  );
}
