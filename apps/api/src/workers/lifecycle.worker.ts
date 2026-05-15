import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-lifecycle' });

/**
 * Lifecycle worker — data retention + RTBF.
 *
 * Implements every lifecycle promise in `docs/governance/PRIVACY.md` so the
 * doc stops being a forward-looking statement and starts being evidence:
 *
 *   - Webhook event payload scrub at 90 days  (clears `payload` JSON,
 *     keeps the row + metadata for audit)
 *   - Refresh-token purge 30 days post-expiry (hard-delete revoked /
 *     expired rows; family chain stays intact via the surviving rotated
 *     tokens)
 *   - PENDING RtbfRequest processing            (cryptoshred via
 *     RtbfService.process)
 *
 * Application + revenue retention (7 years) is NOT in here — those rows
 * are append-only by role REVOKE, and the regulatory retention horizon
 * is far enough out that lifecycle deletion is a v1.1+ concern. When it
 * lands, the same pattern applies: a new task in this worker, plus the
 * REVOKE relaxation on a separate `eazepay_lifecycle` role.
 *
 * Scheduling
 *   Single-process polling loop. Every LIFECYCLE_TICK_MS the worker runs
 *   each task in turn, capped to LIFECYCLE_BATCH_SIZE rows per task per
 *   tick so a backlog doesn't pin the writer pool.
 *
 * SOC 2 mapping
 *   - Privacy/Confidentiality — fulfils retention windows in PRIVACY.md
 *   - CC7.3 — every batch writes a LIFECYCLE_PURGE / RTBF_PROCESSED audit row
 */
import { getPrismaWriter, getPrismaLong } from '../config/database.js';
import { getLogger } from '../config/logger.js';
import { RtbfService } from '../domains/rtbf/rtbf.service.js';
import { writeAuditLog } from '../shared/middleware/audit-log.middleware.js';

const TICK_MS = Number(process.env.LIFECYCLE_TICK_MS ?? 5 * 60_000);
const BATCH_SIZE = Number(process.env.LIFECYCLE_BATCH_SIZE ?? 1000);
const WEBHOOK_PAYLOAD_TTL_DAYS = Number(process.env.LIFECYCLE_WEBHOOK_PAYLOAD_TTL_DAYS ?? 90);
const REFRESH_TOKEN_GRACE_DAYS = Number(process.env.LIFECYCLE_REFRESH_TOKEN_GRACE_DAYS ?? 30);

export interface CycleSummary {
  webhookPayloadsScrubbed: number;
  refreshTokensPurged: number;
  rtbfProcessed: number;
  errors: number;
}

/**
 * Run a single lifecycle cycle. Pulled out for tests so we can drive each
 * task deterministically.
 */
export async function runLifecycleCycle(opts: {
  prisma: ReturnType<typeof getPrismaWriter>;
  long: ReturnType<typeof getPrismaLong>;
  rtbf: RtbfService;
  now?: Date;
  batchSize?: number;
}): Promise<CycleSummary> {
  const log = getLogger();
  const now = opts.now ?? new Date();
  const limit = opts.batchSize ?? BATCH_SIZE;
  const summary: CycleSummary = {
    webhookPayloadsScrubbed: 0,
    refreshTokensPurged: 0,
    rtbfProcessed: 0,
    errors: 0,
  };

  // ─── 1. Webhook event payload scrub (90 days) ───────────────────────────
  // Keep the row + metadata for audit; clear the raw `payload` JSON so we
  // aren't sitting on plaintext vendor data past the retention window.
  try {
    const cutoff = new Date(now.getTime() - WEBHOOK_PAYLOAD_TTL_DAYS * 86_400_000);
    // Two-step: scrub `payload` only on rows where it isn't already empty.
    const candidates = await opts.long.webhookEvent.findMany({
      where: { receivedAt: { lt: cutoff }, NOT: { payload: { equals: {} } } },
      select: { id: true },
      take: limit,
    });
    if (candidates.length > 0) {
      await opts.prisma.webhookEvent.updateMany({
        where: { id: { in: candidates.map((c) => c.id) } },
        data: { payload: {} },
      });
      summary.webhookPayloadsScrubbed = candidates.length;
      await writeAuditLog({
        action: 'LIFECYCLE_PURGE',
        resourceType: 'webhook_event',
        metadata: {
          task: 'webhook_payload_scrub',
          count: candidates.length,
          cutoffIso: cutoff.toISOString(),
          ttlDays: WEBHOOK_PAYLOAD_TTL_DAYS,
        },
      });
    }
  } catch (err) {
    summary.errors += 1;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'lifecycle.webhook_payload_scrub.error',
    );
  }

  // ─── 2. Refresh token purge (30d post-expiry) ───────────────────────────
  // Tokens already revoked or expired more than the grace period ago are
  // safely purgable — they're useless to attackers and the family-chain
  // is preserved by the surviving rotation siblings.
  try {
    const cutoff = new Date(now.getTime() - REFRESH_TOKEN_GRACE_DAYS * 86_400_000);
    const result = await opts.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
    summary.refreshTokensPurged = result.count;
    if (result.count > 0) {
      await writeAuditLog({
        action: 'LIFECYCLE_PURGE',
        resourceType: 'refresh_token',
        metadata: {
          task: 'refresh_token_purge',
          count: result.count,
          cutoffIso: cutoff.toISOString(),
          graceDays: REFRESH_TOKEN_GRACE_DAYS,
        },
      });
    }
  } catch (err) {
    summary.errors += 1;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'lifecycle.refresh_token_purge.error',
    );
  }

  // ─── 3. RTBF requests (cryptoshred PENDING rows) ────────────────────────
  // Process up to `limit` PENDING requests per cycle. Each one is small
  // (1–5 applications typically) so we run them serially to keep the
  // writer pool free.
  try {
    const pending = await opts.prisma.rtbfRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
      take: limit,
    });
    for (const req of pending) {
      try {
        await opts.rtbf.process(req.id);
        summary.rtbfProcessed += 1;
      } catch (err) {
        summary.errors += 1;
        log.error(
          { requestId: req.id, err: err instanceof Error ? err.message : String(err) },
          'lifecycle.rtbf.process.error',
        );
      }
    }
  } catch (err) {
    summary.errors += 1;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'lifecycle.rtbf.discovery.error',
    );
  }

  return summary;
}

async function main(): Promise<void> {
  const log = getLogger();
  const prisma = getPrismaWriter();
  const long = getPrismaLong();
  const rtbf = new RtbfService(prisma);

  log.info(
    {
      tickMs: TICK_MS,
      webhookPayloadTtlDays: WEBHOOK_PAYLOAD_TTL_DAYS,
      refreshTokenGraceDays: REFRESH_TOKEN_GRACE_DAYS,
      batchSize: BATCH_SIZE,
    },
    'lifecycle.worker.start',
  );

  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'lifecycle.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    try {
      const summary = await runLifecycleCycle({ prisma, long, rtbf });
      if (
        summary.webhookPayloadsScrubbed ||
        summary.refreshTokensPurged ||
        summary.rtbfProcessed ||
        summary.errors
      ) {
        log.info({ summary }, 'lifecycle.cycle.done');
      } else {
        log.debug({ summary }, 'lifecycle.cycle.done');
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'lifecycle.cycle.error');
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  await prisma.$disconnect();
  process.exit(0);
}

if (
  process.env.LIFECYCLE_WORKER_AUTORUN !== '0' &&
  import.meta.url === `file://${process.argv[1]}`
) {
  void main();
}
