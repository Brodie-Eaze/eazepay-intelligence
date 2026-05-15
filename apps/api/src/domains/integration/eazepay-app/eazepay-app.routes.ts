/**
 * POST /api/v1/integration/eazepay-app/events
 *
 * Inbound webhook from EazePay App's WebhookDispatcher. Stripe-style
 * HMAC-SHA-256 verification + idempotency + envelope validation.
 *
 * Status: stub. Verifies the envelope + signature and returns 202 with
 * the parsed event metadata. Does NOT persist yet — that requires the
 * `WebhookSource.EAZEPAY_APP` Prisma enum migration filed for the next
 * session. The route is intentionally NOT registered in server.ts until
 * the migration + drain handlers land, so we don't ship a half-wired
 * endpoint to production.
 *
 * Contract: docs/integration/eazepay-app-contract.md
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getEnv } from '../../../config/env.js';
import { errors } from '../../../shared/errors/app-error.js';
import { EazepayAppEventEnvelopeSchema } from './envelope.schema.js';
import { isKnownEazepayAppEventType } from './event-types.js';

const SIG_HEADERS = ['x-eazepay-signature', 'x-eazepay-signature-placeholder'] as const;
const TS_HEADER = 'x-eazepay-timestamp';
const KEY_HEADER = 'idempotency-key';
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
  app.post('/integration/eazepay-app/events', async (req, reply) => {
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

    // ─── Timestamp tolerance ───────────────────────────────────────────
    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) throw errors.invalidSignature();
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (skew > TOLERANCE_SECONDS) throw errors.invalidSignature();

    // ─── HMAC compare ──────────────────────────────────────────────────
    // App's dispatcher signs over `JSON.stringify(envelope)`. We mirror
    // that here — both sides re-stringify deterministically (V8
    // preserves insertion order, Fastify doesn't reorder). When we
    // outgrow this and need byte-exact comparison (e.g. payload
    // contains floats), add @fastify/raw-body and switch to req.rawBody.
    // The existing webhook signature middleware uses the same
    // JSON.stringify approach — consistent within the codebase.
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
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

    // ─── Stub response ─────────────────────────────────────────────────
    // TODO(next session): once `WebhookSource.EAZEPAY_APP` migration
    // lands, replace this with the durable persistence + drain path
    // (mirror verifyWebhookSignature middleware in
    // shared/middleware/webhook-signature.middleware.ts).
    reply.status(202);
    return {
      accepted: true,
      eventId: env_.eventId,
      eventType: env_.eventType,
      knownEventType: isKnownEazepayAppEventType(env_.eventType),
      idempotencyKey,
      persisted: false,
      note: 'Stub — persistence pending WebhookSource.EAZEPAY_APP migration.',
    };
  });
}
