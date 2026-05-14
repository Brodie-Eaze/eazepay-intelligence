/**
 * POST /api/v1/integration/highsale/snapshots
 *
 * Inbound: HighSale ("EZ Check") pushes one credit-data snapshot per
 * application across medpay/tradepay/coachpay. Every BNPL application
 * carries a HighSale pull; the warehouse needs every snapshot so
 * operator + investor surfaces can see the credit profile of every
 * applicant in the funnel.
 *
 * Status: **stub**. Verifies HMAC + envelope and returns 202 with the
 * parsed snapshotId. Does NOT persist yet — that needs the
 * `HighsaleSnapshot` Prisma model (filed for the migration session
 * after the HighSale JSON spec arrives in the repo). The route is
 * intentionally NOT registered in server.ts until persistence + drain
 * handlers land.
 *
 * Contract: docs/architecture/data-warehouse-overview.md § Plane 2
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getEnv } from '../../../config/env.js';
import { errors } from '../../../shared/errors/app-error.js';
import { HighsaleSnapshotEnvelopeSchema } from './highsale-snapshot.schema.js';

const SIG_HEADER = 'x-highsale-signature';
const TS_HEADER = 'x-highsale-timestamp';
const KEY_HEADER = 'idempotency-key';
const TOLERANCE_SECONDS = 300;

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
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function registerHighsaleIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/integration/highsale/snapshots', async (req, reply) => {
    const env = getEnv();

    const ts = firstHeader(req, TS_HEADER);
    const idempotencyKey = firstHeader(req, KEY_HEADER);
    const sigRaw = firstHeader(req, SIG_HEADER);
    if (!ts || !idempotencyKey || !sigRaw) throw errors.invalidSignature();

    const sig = stripSha256Prefix(sigRaw);

    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) throw errors.invalidSignature();
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (skew > TOLERANCE_SECONDS) throw errors.invalidSignature();

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    if (!verifySignature(rawBody, ts, sig, env.HIGHSALE_WEBHOOK_SECRET)) {
      throw errors.invalidSignature();
    }

    const parsed = HighsaleSnapshotEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        accepted: false,
        reason: 'invalid_envelope',
        issues: parsed.error.issues,
      };
    }
    const snap = parsed.data;

    // TODO(next session): once HighSale JSON spec is pinned + the
    // HighsaleSnapshot Prisma model migration lands, replace this stub
    // with the durable persistence path:
    //   - dedupe on (snapshotId, externalApplicationId)
    //   - encrypt sensitive fields under the per-org DEK (ADR-002)
    //   - emit a `credit_enrichment.captured` row to webhook_events
    //   - audit (CREDIT_SNAPSHOT_RECEIVED)
    reply.status(202);
    return {
      accepted: true,
      snapshotId: snap.snapshotId,
      externalApplicationId: snap.externalApplicationId,
      vertical: snap.vertical,
      idempotencyKey,
      persisted: false,
      note: 'Stub — persistence pending HighsaleSnapshot Prisma model + JSON-spec lock-in.',
    };
  });
}
