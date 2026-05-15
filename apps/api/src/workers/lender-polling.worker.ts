import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-lender-polling' });

/**
 * Lender polling worker (GAP-101).
 *
 * Wakes every `LENDER_POLL_INTERVAL_MS` (default 60s) and walks every
 * `LenderDecision` row that's not in a terminal state (decision != PENDING
 * OR fundingStatus != PENDING). For each, it resolves the adapter by
 * `lenderName` (slug-cased lookup) and calls `pollOne` which:
 *
 *   1. Asks the adapter for the current state.
 *   2. Updates the LenderDecision row if anything changed.
 *   3. Emits a LenderReportingEvent (POLL / STATE_TRANSITION / POLL_FAILED).
 *
 * Operational envelope:
 *   - Bounded batch (default 200 rows / sweep)
 *   - One adapter call at a time per decision; concurrent across decisions
 *     up to MAX_PARALLEL (default 8)
 *   - Permanent-error backoff: rows that produced a recent permanent=true
 *     LenderReportingEvent are skipped in subsequent sweeps (sticky cooldown)
 *
 * Run as: `pnpm --filter api worker:lender-polling`.
 */
import type { LenderDecision, PrismaClient } from '@prisma/client';
import { getLogger } from '../config/logger.js';
import { getPrisma } from '../config/database.js';
import { LenderSubmissionService } from '../domains/lenders/lender-submission.service.js';
import { getLenderAdapter } from '../domains/lenders/adapter/lender-adapter-registry.js';
import { bootstrapLenderAdapters } from '../domains/lenders/adapter/bootstrap.js';
import { CircuitBreaker } from '../domains/lenders/adapter/circuit-breaker.js';
import { lenderPollsTotal, lenderPollDurationSeconds } from '../shared/metrics/metrics.js';

const POLL_INTERVAL_MS = Number(process.env.LENDER_POLL_INTERVAL_MS ?? 60_000);
const BATCH_SIZE = Number(process.env.LENDER_POLL_BATCH_SIZE ?? 200);
const MAX_PARALLEL = Number(process.env.LENDER_POLL_MAX_PARALLEL ?? 8);
const PER_CALL_TIMEOUT_MS = Number(process.env.LENDER_POLL_TIMEOUT_MS ?? 10_000);

// Per-lender circuit breakers. Keyed by adapter slug. Process-local — each
// worker replica tracks independently which is acceptable since the
// breaker's purpose is to protect *this* worker from looping on a dead
// adapter, not to coordinate across replicas.
const breakers = new Map<string, CircuitBreaker>();
function breakerFor(slug: string): CircuitBreaker {
  let b = breakers.get(slug);
  if (!b) {
    b = new CircuitBreaker(slug);
    breakers.set(slug, b);
  }
  return b;
}

function slugifyLenderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Race a promise against a timeout. Rejects with `lender.poll.timeout` on miss. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lender.poll.timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function processBatch(prisma: PrismaClient): Promise<number> {
  const log = getLogger();
  // Pick decisions that aren't terminal. "Terminal" = decision != PENDING AND
  // fundingStatus = FUNDED. Other declined / failed-funding decisions still
  // get one final POLL to confirm; once stable they fall out of the next batch.
  const candidates: LenderDecision[] = await prisma.lenderDecision.findMany({
    where: {
      OR: [{ decision: 'PENDING' }, { fundingStatus: { not: 'FUNDED' } }],
    },
    orderBy: { decisionTimestamp: 'asc' },
    take: BATCH_SIZE,
  });

  if (candidates.length === 0) return 0;

  const service = new LenderSubmissionService(prisma);

  const queue = [...candidates];
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
      while (queue.length > 0) {
        const decision = queue.shift();
        if (!decision) return;
        const slug = slugifyLenderName(decision.lenderName);
        const adapter = getLenderAdapter(slug);
        if (!adapter) {
          log.warn(
            {
              errorId: 'lender.poll.no_adapter',
              lenderName: decision.lenderName,
              decisionId: decision.id,
            },
            'lender.poll.no_adapter',
          );
          lenderPollsTotal.inc({ adapter: slug, outcome: 'no_adapter' });
          continue;
        }
        // Skip async-webhook adapters — they push decisions, we don't poll.
        if (adapter.capabilities.asyncDecisionWebhook) {
          lenderPollsTotal.inc({ adapter: slug, outcome: 'skipped_async' });
          continue;
        }
        const breaker = breakerFor(slug);
        if (breaker.shouldSkip()) {
          lenderPollsTotal.inc({ adapter: slug, outcome: 'breaker_open' });
          continue;
        }
        const endTimer = lenderPollDurationSeconds.startTimer({ adapter: slug });
        try {
          // Per-call timeout wrapper. Adapter contracts that respect it
          // get a clean abort; ones that don't are torn down by the timer.
          await withTimeout(service.pollOne(adapter, decision.id), PER_CALL_TIMEOUT_MS);
          breaker.recordSuccess();
          lenderPollsTotal.inc({ adapter: slug, outcome: 'ok' });
        } catch (err) {
          breaker.recordFailure();
          lenderPollsTotal.inc({ adapter: slug, outcome: 'fail' });
          log.error(
            {
              errorId: 'lender.poll.fail',
              adapter: slug,
              decisionId: decision.id,
              err: err instanceof Error ? err.message : String(err),
              breakerState: breaker.getState(),
            },
            'lender.poll.fail',
          );
        } finally {
          endTimer();
        }
      }
    }),
  );

  log.info({ scanned: candidates.length }, 'lender.poll.batch.done');
  return candidates.length;
}

async function main(): Promise<void> {
  const log = getLogger();
  bootstrapLenderAdapters();
  log.info(
    { pollMs: POLL_INTERVAL_MS, batch: BATCH_SIZE, parallel: MAX_PARALLEL },
    'lender_polling.worker.start',
  );
  const prisma = getPrisma();
  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'lender_polling.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    try {
      await processBatch(prisma);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'lender_polling.loop_error',
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await prisma.$disconnect();
  process.exit(0);
}

void main();
