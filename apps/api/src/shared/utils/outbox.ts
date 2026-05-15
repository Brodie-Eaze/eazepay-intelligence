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
import { getBootstrapOrgId } from '../tenant/bootstrap-org.js';

export interface OutboxAppend {
  kind: OutboxKind;
  payload: object;
  refType?: string;
  refId?: string;
  /**
   * Phase 1 retrofit: tenant scope for the outbox row. Optional during the
   * Phase 1.3 transition — callers that don't yet have orgId in scope get
   * the bootstrap org as a fallback (matches the previous behaviour where
   * outbox rows were globally namespaced). Once every call site is
   * retrofitted, drop the optionality.
   */
  orgId?: string;
}

export async function appendToOutbox(
  tx: Prisma.TransactionClient | PrismaClient,
  entry: OutboxAppend,
): Promise<string> {
  const id = uuidv7();
  // `tx` may be a TransactionClient (no $-prefixed lifecycle methods) or a
  // bare PrismaClient. Both have organization.findUnique, so the bootstrap
  // lookup works either way. Cast through unknown for the bootstrap call to
  // satisfy the union.
  const orgId =
    entry.orgId ?? (await getBootstrapOrgId(tx as unknown as PrismaClient));
  await tx.outboxEvent.create({
    data: {
      id,
      orgId,
      kind: entry.kind,
      payload: entry.payload as Prisma.InputJsonValue,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
    },
  });
  return id;
}
