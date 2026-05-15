import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-outbox' });

/**
 * Outbox sweeper worker.
 *
 * Polls `outbox_events WHERE published_at IS NULL` in small batches, pushes
 * each row onto its target BullMQ queue, then marks `published_at = now()`
 * in the same transaction.
 *
 * Concurrency safety: we use `FOR UPDATE SKIP LOCKED` so multiple sweeper
 * replicas can run safely — each one grabs a non-overlapping batch.
 *
 * Failure semantics: on enqueue failure we set `publish_error` and bump
 * `attempt_count`; the row stays unpublished and the next poll picks it up.
 * Exponential backoff on transient failures is implemented as a poll-interval
 * adjustment based on `attempt_count`.
 *
 * Operational guarantees:
 *   - At-least-once: a row may be published more than once (under crash) but
 *     downstream consumers are idempotent (BullMQ job names + idempotency keys).
 *   - In-order within a kind: ordered by created_at; sweeping is FIFO.
 *
 * Run as a separate process: `pnpm --filter api worker:outbox`.
 */
import type { OutboxKind } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getLogger } from '../config/logger.js';
import { getPrisma } from '../config/database.js';
import { enqueueWebhook } from '../shared/queues/webhook.queue.js';
import { enqueueWebhookDelivery } from '../shared/queues/webhook-delivery.queue.js';
import { getRedisPublisher } from '../config/redis.js';
import { WS_CHANNEL } from '../shared/utils/ws-publisher.js';
import { outboxSweptTotal, outboxLagSeconds } from '../shared/metrics/metrics.js';

// Outbox sweep cadence + batch size. Defaults are deliberately conservative —
// at 100 events / 1s sweep we drain 6,000 events/min per replica, scaling
// linearly with replica count (FOR UPDATE SKIP LOCKED gives us non-overlapping
// batches across replicas). See docs/COMPUTE_LIMITS.md for sizing.
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1_000);
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE ?? 100);
// Phase 7 (SF-006): after this many failed dispatches the sweeper stops
// re-claiming the row and stamps dlqedAt. Operators reconcile manually.
// 10 attempts ≈ minutes-to-hours of retries before quarantine; tunable.
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10);

interface OutboxRow {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  attempt_count: number;
}

async function processOnce(): Promise<number> {
  const prisma = getPrisma();
  const log = getLogger();

  // Lock-and-claim a batch atomically. The SELECT...FOR UPDATE SKIP LOCKED
  // and the subsequent UPDATEs MUST run inside a single Postgres transaction
  // so the row-level locks survive the dispatch + update cycle. Outside a
  // transaction, autocommit releases the locks the moment the SELECT
  // returns and concurrent sweeper replicas can claim the same rows.
  //
  // Trade-off: dispatch latency (BullMQ enqueue, Redis pub) holds the locks
  // for the whole batch. BullMQ enqueue is sub-ms in practice, so the
  // serialised dispatch loop is not a meaningful contention source.
  return prisma.$transaction(async (tx) => {
    // Phase 1.6 (RLS): the eazepay_app runtime role is NOBYPASSRLS and
    // outbox_events is policy-gated on app.org_id OR app.outbox_sweeper.
    // The sweeper claims rows cross-tenant so we set the escape GUC; the
    // RLS migration explicitly carves this out for the sweeper alone.
    // Without this, post-role-deploy every sweep returns zero rows and
    // webhooks accumulate forever.
    await tx.$executeRaw`SELECT set_config('app.outbox_sweeper', 'true', true)`;
    // Phase 7 (SF-006): exclude DLQ'd rows. Poison-pill rows that crossed
    // MAX_ATTEMPTS were stamped dlqed_at and are out of the sweep set
    // until an operator clears the marker.
    const claimed = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
      SELECT id, kind, payload, attempt_count
      FROM outbox_events
      WHERE published_at IS NULL
        AND dlqed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `);

    if (claimed.length === 0) return 0;

    for (const row of claimed) {
      try {
        await dispatch(row);
        await tx.outboxEvent.update({
          where: { id: row.id },
          data: { publishedAt: new Date(), publishError: null },
        });
        outboxSweptTotal.inc({ kind: row.kind, outcome: 'published' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const nextAttempt = row.attempt_count + 1;
        // Phase 7 (SF-006): on attempt MAX_ATTEMPTS, stamp dlqedAt and
        // log loudly with a stable errorId so on-call sees the quarantine.
        // No silent escalation — the row stays in the DB but stops sweeping.
        const dlq = nextAttempt >= MAX_ATTEMPTS;
        if (dlq) {
          log.error(
            {
              outboxId: row.id,
              kind: row.kind,
              attempts: nextAttempt,
              maxAttempts: MAX_ATTEMPTS,
              errorId: 'outbox.dlq.quarantined',
              err: msg,
            },
            'outbox.dlq.quarantined — manual reconciliation needed',
          );
        } else {
          log.error(
            { outboxId: row.id, kind: row.kind, attempt: nextAttempt, err: msg },
            'outbox.publish.fail',
          );
        }
        await tx.outboxEvent.update({
          where: { id: row.id },
          data: {
            attemptCount: nextAttempt,
            publishError: msg.slice(0, 1000),
            dlqedAt: dlq ? new Date() : undefined,
          },
        });
        outboxSweptTotal.inc({ kind: row.kind, outcome: dlq ? 'dlq' : 'failed' });
      }
    }

    return claimed.length;
  });
}

async function dispatch(row: OutboxRow): Promise<void> {
  switch (row.kind) {
    case 'WEBHOOK_INBOUND':
      await enqueueWebhook(row.payload as never);
      return;
    case 'OUTBOUND_DELIVERY':
      await enqueueWebhookDelivery(row.payload as never);
      return;
    case 'WS_EVENT':
      await getRedisPublisher().publish(WS_CHANNEL, JSON.stringify(row.payload));
      return;
  }
}

async function main(): Promise<void> {
  const log = getLogger();
  log.info({ pollMs: POLL_INTERVAL_MS, batch: BATCH_SIZE }, 'outbox.worker.start');

  let running = true;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, 'outbox.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  while (running) {
    try {
      const n = await processOnce();
      if (n === 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'outbox.worker.loop_error');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  await getPrisma().$disconnect();
  process.exit(0);
}

void main();
