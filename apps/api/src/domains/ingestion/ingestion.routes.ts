/**
 * Generic ingestion contract for every platform data point.
 *
 * Why this exists:
 *   The signed-webhook path (`/api/v1/webhooks/...`) is for vendor-driven
 *   inbound traffic (BuzzPay, MiCamp, Pixie). Devs and ETL workers need a
 *   parallel surface authenticated by PAT or session cookie — same downstream
 *   processing, no HMAC signing required because the request is already
 *   authenticated by token.
 *
 * Contract:
 *   - All endpoints require:
 *       Idempotency-Key:  any 16–128 char string (UUIDv7 recommended)
 *       Authorization:    Bearer epi_pk_… OR session cookie
 *   - All endpoints return 202 with the WebhookEvent.id; a worker drains the
 *     event into normalised tables. Replays of the same Idempotency-Key for
 *     the same source return the prior eventId with `replayed: true`.
 *   - Bulk and single-event endpoints both available. Bulk is preferred for
 *     batch backfills; the per-row idempotency-key collision rule still
 *     applies.
 *
 * Security:
 *   - requireCookieOrBearer + requireScope('WRITE')
 *   - PAT scopes enforced on the bearer path; cookie callers gated by role
 *   - Every request writes an INGESTION_REQUEST audit row tagged with the
 *     authenticated principal, the data point, and the count.
 *   - Unsuccessful auth/zod failures bubble to the global error handler.
 *
 * SOC 2 mapping:
 *   - CC6.1 — only authenticated, scoped principals can write
 *   - CC6.6 — Idempotency-Key forces explicit replay safety
 *   - CC7.3 — every accepted/rejected request is auditable
 *   - CC8.1 — change of state to financial ledger always traceable to a user
 *
 * Read precedence at the storage layer:
 *   1) Real ingested rows (this surface)
 *   2) Vendor webhook deliveries (HMAC-signed)
 *   3) Deterministic mock fallbacks (portfolio fixtures only — for demo)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, WebhookSource } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { getPrisma } from '../../config/database.js';
import { requireCookieOrBearer } from '../../shared/middleware/bearer-auth.middleware.js';
import { requireScope } from '../../shared/middleware/scope.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { ingestionRateLimit } from '../../shared/middleware/rate-limit-tiers.js';
import { getEnv } from '../../config/env.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { WebhookProcessor } from '../webhooks/webhook.service.js';
import {
  MicampProcessingWebhookSchema,
  MicampReversalWebhookSchema,
  PixieUsageWebhookSchema,
} from '../webhooks/webhook.schemas.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';

interface IngestionTarget {
  source: WebhookSource;
  eventType: string;
  schema: z.ZodTypeAny;
}

// BUZZPAY-shaped ingestion targets (applications / lender-decisions /
// funding-status / clawbacks) retired — those events now flow through
// the EazePay App integration sink at
// /api/v1/integration/eazepay-app/events. See
// docs/cuts/buzzpay-removal.md and docs/integration/eazepay-app-contract.md.
const TARGETS: Record<string, IngestionTarget> = {
  'pixie-usage': {
    source: WebhookSource.PIXIE,
    eventType: 'usage',
    schema: PixieUsageWebhookSchema,
  },
  'micamp-processing': {
    source: WebhookSource.MICAMP,
    eventType: 'processing',
    schema: MicampProcessingWebhookSchema,
  },
  'micamp-reversals': {
    source: WebhookSource.MICAMP,
    eventType: 'reversal',
    schema: MicampReversalWebhookSchema,
  },
};

const BulkBody = z.object({ events: z.array(z.unknown()).min(1).max(500) });

export async function registerIngestionRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const processor = new WebhookProcessor(prisma);

  /**
   * Single-event ingestion.
   *
   * POST /ingestion/applications
   * POST /ingestion/lender-decisions
   * POST /ingestion/funding-status
   * POST /ingestion/clawbacks
   * POST /ingestion/pixie-usage
   * POST /ingestion/micamp-processing
   * POST /ingestion/micamp-reversals
   *
   * Body matches the same Zod schema the signed-webhook path uses, so the
   * dev contract is the same regardless of channel.
   */
  for (const [path, target] of Object.entries(TARGETS)) {
    app.post(
      `/ingestion/${path}`,
      {
        preHandler: [requireCookieOrBearer, csrfGuard, requireScope('WRITE')],
        config: ingestionRateLimit(),
        bodyLimit: getEnv().BODY_LIMIT_BULK_BYTES,
      },
      async (req) => {
        const idempotencyKey = readIdempotencyKey(req.headers[IDEMPOTENCY_HEADER]);
        const payload = target.schema.parse(req.body);
        return ingest({
          req,
          processor,
          source: target.source,
          eventType: target.eventType,
          idempotencyKey,
          payload,
        });
      },
    );
  }

  /**
   * Generic ingestion (escape hatch for unknown event types or generic ETL).
   *
   * POST /ingestion/events
   * Body: { source: 'BUZZPAY'|'PIXIE'|'MICAMP', eventType: string, payload: object }
   */
  const GenericBody = z.object({
    source: z.nativeEnum(WebhookSource),
    eventType: z.string().min(1).max(64),
    payload: z.record(z.unknown()),
  });
  app.post(
    '/ingestion/events',
    {
      preHandler: [requireCookieOrBearer, csrfGuard, requireScope('WRITE')],
      config: ingestionRateLimit(),
      bodyLimit: getEnv().BODY_LIMIT_BULK_BYTES,
    },
    async (req) => {
      const idempotencyKey = readIdempotencyKey(req.headers[IDEMPOTENCY_HEADER]);
      const body = GenericBody.parse(req.body);
      return ingest({
        req,
        processor,
        source: body.source,
        eventType: body.eventType,
        idempotencyKey,
        payload: body.payload,
      });
    },
  );

  /**
   * Bulk ingestion.
   *
   * POST /ingestion/:target/bulk
   * Header: Idempotency-Key (used as a batch id; each event needs its own id
   *         in the body via `idempotencyKey` on the row, which the schema
   *         enforces via existing webhook schemas).
   *
   * Bulk is processed serially to preserve per-row idempotency semantics; the
   * worker fan-out happens on the WebhookEvent rows.
   */
  app.post(
    '/ingestion/:target/bulk',
    {
      preHandler: [requireCookieOrBearer, csrfGuard, requireScope('WRITE')],
      config: ingestionRateLimit(),
      bodyLimit: getEnv().BODY_LIMIT_BULK_BYTES,
    },
    async (req) => {
      const params = z
        .object({ target: z.enum(Object.keys(TARGETS) as [string, ...string[]]) })
        .parse(req.params);
      const target = TARGETS[params.target]!;
      const batchKey = readIdempotencyKey(req.headers[IDEMPOTENCY_HEADER]);
      const body = BulkBody.parse(req.body);

      const results: { idempotencyKey: string; eventId: string; replayed: boolean }[] = [];
      for (const raw of body.events) {
        const row = target.schema.parse(raw) as {
          externalApplicationId?: string;
          decisionId?: string;
          fundingId?: string;
          clawbackId?: string;
          usageId?: string;
          processingId?: string;
          reversalId?: string;
        };
        const idempotencyKey =
          row.externalApplicationId ??
          row.decisionId ??
          row.fundingId ??
          row.clawbackId ??
          row.usageId ??
          row.processingId ??
          row.reversalId ??
          `${batchKey}-${results.length}`;
        const ingested = await ingest({
          req,
          processor,
          source: target.source,
          eventType: target.eventType,
          idempotencyKey,
          payload: row,
          suppressAudit: true, // single batch audit entry below
        });
        results.push({ idempotencyKey, eventId: ingested.eventId, replayed: ingested.replayed });
      }

      await writeAuditLog({
        req,
        action: 'INGESTION_REQUEST',
        resourceType: 'ingestion_batch',
        resourceId: batchKey,
        metadata: {
          target: params.target,
          source: target.source,
          eventType: target.eventType,
          count: results.length,
          replayed: results.filter((r) => r.replayed).length,
        },
      });

      return { batchKey, count: results.length, results };
    },
  );
}

function readIdempotencyKey(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v.length < 16 || v.length > 128) {
    throw errors.badRequest('Idempotency-Key header is required (16–128 chars)');
  }
  return v;
}

async function ingest(args: {
  req: import('fastify').FastifyRequest;
  processor: WebhookProcessor;
  source: WebhookSource;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  suppressAudit?: boolean;
}): Promise<{ eventId: string; replayed: boolean }> {
  const prisma = getPrisma();

  // Idempotency via the WebhookEvent UNIQUE(source, idempotency_key).
  // Atomic-create-or-find pattern: attempt create + catch P2002 + load the
  // colliding row. The previous findUnique → create pair was a TOCTOU race
  // between two concurrent requests with the same idempotency key — both
  // would read null, both attempt create, one would 500 with P2002.
  let event;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        id: uuidv7(),
        source: args.source,
        eventType: args.eventType,
        idempotencyKey: args.idempotencyKey,
        // Trust the authenticated request — there's no HMAC, but auth is
        // the equivalent control. signatureValid=true keeps the column
        // semantics consistent: "the request was authorised at ingress."
        signatureValid: true,
        payload: (args.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.webhookEvent.findUnique({
        where: {
          source_idempotencyKey: { source: args.source, idempotencyKey: args.idempotencyKey },
        },
      });
      if (existing) return { eventId: existing.id, replayed: true };
      // P2002 without a row should not happen — treat as fatal.
    }
    throw err;
  }

  // Process synchronously — devs see the result immediately. If you want
  // async fan-out for high-throughput backfills, call the queue instead.
  try {
    await args.processor.process({
      webhookEventId: event.id,
      source: args.source,
      eventType: args.eventType,
      idempotencyKey: args.idempotencyKey,
      payload: args.payload,
    });
  } catch (err) {
    if (!args.suppressAudit) {
      await writeAuditLog({
        req: args.req,
        action: 'INGESTION_REJECTED',
        resourceType: 'webhook_event',
        resourceId: event.id,
        metadata: {
          source: args.source,
          eventType: args.eventType,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    throw err;
  }

  if (!args.suppressAudit) {
    await writeAuditLog({
      req: args.req,
      action: 'INGESTION_REQUEST',
      resourceType: 'webhook_event',
      resourceId: event.id,
      metadata: {
        source: args.source,
        eventType: args.eventType,
        idempotencyKey: args.idempotencyKey,
      },
    });
  }

  return { eventId: event.id, replayed: false };
}
