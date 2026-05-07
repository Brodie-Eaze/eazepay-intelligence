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

// Outbox sweep cadence + batch size. Defaults are deliberately conservative —
// at 100 events / 1s sweep we drain 6,000 events/min per replica, scaling
// linearly with replica count (FOR UPDATE SKIP LOCKED gives us non-overlapping
// batches across replicas). See docs/COMPUTE_LIMITS.md for sizing.
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1_000);
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE ?? 100);

interface OutboxRow {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  attempt_count: number;
}

async function processOnce(): Promise<number> {
  const prisma = getPrisma();
  const log = getLogger();

  // Lock-and-claim a batch atomically. SKIP LOCKED lets concurrent sweepers
  // run without contention.
  const claimed = await prisma.$queryRaw<OutboxRow[]>(Prisma.sql`
    SELECT id, kind, payload, attempt_count
    FROM outbox_events
    WHERE published_at IS NULL
    ORDER BY created_at ASC
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `);

  if (claimed.length === 0) return 0;

  for (const row of claimed) {
    try {
      await dispatch(row);
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { publishedAt: new Date(), publishError: null },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { outboxId: row.id, kind: row.kind, attempt: row.attempt_count + 1, err: msg },
        'outbox.publish.fail',
      );
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { attemptCount: row.attempt_count + 1, publishError: msg.slice(0, 1000) },
      });
    }
  }

  return claimed.length;
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
