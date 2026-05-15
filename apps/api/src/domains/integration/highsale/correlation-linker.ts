/**
 * Application correlation linker (GAP-106).
 *
 * Today credit_enrichments.applicationId is nullable — HighSale snapshots
 * arrive before the corresponding Intelligence Application row has been
 * created (App-side correlation-token rollout is in flight). This linker:
 *
 *   1. Reads credit_enrichments WHERE applicationId IS NULL.
 *   2. Matches against applications on (orgId, consumerEmailHash) within
 *      ±7 days of the snapshot's pulledAt.
 *   3. Updates the credit_enrichments row with the resolved applicationId.
 *
 * Run as a side-effect of the highsale.snapshots ingestion path (so
 * snapshots get linked at write time when the Application already
 * exists) and as a periodic backfill via `pnpm worker:correlation-linker`.
 *
 * Why this is split from the main HighSale write path:
 *   - The write path optimises for ingestion latency; the linker tolerates
 *     latency in exchange for catching late-arriving Applications.
 *   - Idempotent — calling resolveOne twice on the same row is a no-op.
 *   - Operator-runnable: `npm run worker:correlation-linker` rebuilds
 *     all unresolved links after a misconfiguration.
 *
 * Match criteria are deliberately tight (org + email hash + 7-day window)
 * because cross-tenant or cross-customer mis-linking would expose PII to
 * the wrong audit trail. False negatives (unresolved rows) are recoverable
 * via the periodic re-sweep; false positives are not.
 */
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { getLogger } from '../../../config/logger.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface LinkerResult {
  scanned: number;
  linked: number;
  ambiguous: number;
  unresolved: number;
}

/**
 * Resolve up to `limit` unresolved credit_enrichments rows in one batch.
 * Returns counters for observability.
 */
export async function resolveBatch(prisma: PrismaClient, limit = 200): Promise<LinkerResult> {
  const log = getLogger();
  const rows = await prisma.creditEnrichment.findMany({
    where: { applicationId: null, deletedAt: null },
    select: {
      id: true,
      orgId: true,
      consumerEmailHash: true,
      pulledAt: true,
      externalApplicationId: true,
    },
    orderBy: { pulledAt: 'desc' },
    take: limit,
  });
  if (rows.length === 0) return { scanned: 0, linked: 0, ambiguous: 0, unresolved: 0 };

  let linked = 0;
  let ambiguous = 0;
  let unresolved = 0;

  for (const r of rows) {
    const from = new Date(r.pulledAt.getTime() - WINDOW_MS);
    const to = new Date(r.pulledAt.getTime() + WINDOW_MS);
    // Strategy 1: externalApplicationId match — exact, highest confidence.
    let matchId: string | null = null;
    if (r.externalApplicationId) {
      const exact = await prisma.application.findFirst({
        where: { orgId: r.orgId, externalApplicationId: r.externalApplicationId },
        select: { id: true },
      });
      matchId = exact?.id ?? null;
    }
    // Strategy 2: emailHash + time window.
    if (!matchId) {
      const candidates = await prisma.application.findMany({
        where: {
          orgId: r.orgId,
          consumerEmailHash: r.consumerEmailHash,
          createdAt: { gte: from, lte: to },
        },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      if (candidates.length === 1) {
        matchId = candidates[0]!.id;
      } else if (candidates.length > 1) {
        ambiguous++;
        log.warn(
          {
            errorId: 'correlation.ambiguous',
            creditEnrichmentId: r.id,
            candidateCount: candidates.length,
          },
          'correlation.ambiguous — skipped',
        );
        continue;
      }
    }
    if (!matchId) {
      unresolved++;
      continue;
    }
    try {
      await prisma.creditEnrichment.update({
        where: { id: r.id },
        data: { applicationId: matchId },
      });
      linked++;
      await writeAuditLog({
        action: 'CREDIT_SNAPSHOT_RECEIVED',
        resourceType: 'credit_enrichment',
        resourceId: r.id,
        orgId: r.orgId,
        metadata: { linkedApplicationId: matchId, strategy: 'correlation-linker' },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        // Row deleted between read + update — skip.
        unresolved++;
        continue;
      }
      throw err;
    }
  }

  return { scanned: rows.length, linked, ambiguous, unresolved };
}
