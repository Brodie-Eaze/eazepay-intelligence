/**
 * Outbox helpers.
 *
 * The outbox pattern guarantees "if it's in the database, it WILL be processed".
 * Without an outbox we have a two-phase commit problem:
 *
 *   1. Verify webhook signature
 *   2. INSERT WebhookEvent       (durable)
 *   3. enqueue BullMQ job        (durable in Redis)
 *   4. reply 202
 *
 * If the process crashes between step 2 and step 3 we have a webhook event
 * persisted but no work scheduled — silently lost. The outbox closes the gap
 * by collapsing 2+3 into a single transaction:
 *
 *   1. Verify
 *   2. tx { INSERT WebhookEvent; INSERT OutboxEvent(kind=WEBHOOK_INBOUND); }
 *   3. reply 202
 *   ---
 *   4. (separate process) outbox.worker scans WHERE published_at IS NULL,
 *      pushes to BullMQ, marks the row published. Idempotent via
 *      `published_at IS NULL` filter — concurrent sweepers all SKIP LOCKED.
 *
 * The recovery delta is bounded by the sweeper poll interval (1s default).
 *
 * Trade-off: every event incurs one extra INSERT. At our scale (target
 * <1000 webhooks/sec) this is invisible. At 10× we'd partition `outbox_events`
 * by created-at and prune aggressively.
 */
import { v7 as uuidv7 } from 'uuid';
import type { OutboxKind, Prisma, PrismaClient } from '@prisma/client';

export interface OutboxAppend {
  kind: OutboxKind;
  payload: object;
  refType?: string;
  refId?: string;
}

export async function appendToOutbox(
  tx: Prisma.TransactionClient | PrismaClient,
  entry: OutboxAppend,
): Promise<string> {
  const id = uuidv7();
  await tx.outboxEvent.create({
    data: {
      id,
      kind: entry.kind,
      payload: entry.payload as Prisma.InputJsonValue,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
    },
  });
  return id;
}
