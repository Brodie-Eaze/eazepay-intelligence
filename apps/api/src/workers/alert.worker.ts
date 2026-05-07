import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-alert' });

/**
 * Alert evaluation worker.
 *
 * Polls active AlertRule rows and applies the state machine:
 *
 *   rule.evaluate() = HIT  → ensure exactly one OPEN alert exists for the
 *                            rule (no double-fire). New alert dispatches
 *                            to the rule's NotificationChannel.
 *   rule.evaluate() = COOL → if an OPEN/ACKNOWLEDGED alert exists, mark
 *                            RESOLVED with resolvedAt=now() and audit.
 *
 * Per-rule cadence is bounded below by `windowMinutes` — we don't re-evaluate
 * a 60-minute rule every 30 seconds, that would generate noisy duplicate
 * dispatches. The evaluator is idempotent so missed ticks are safe; we
 * track `lastEvaluatedAt` in Redis so different worker replicas don't all
 * race on the same rule.
 *
 * Run as a separate process: `pnpm --filter api worker:alert`.
 *
 * SOC 2 mapping:
 *   - CC4.1 — ongoing evaluation, scheduled, evidenced in audit_logs
 *   - CC7.3 — every fire/resolve writes an ALERT_FIRED / ALERT_RESOLVED row
 */
import { v7 as uuidv7 } from 'uuid';
import { Prisma } from '@prisma/client';
import type { Alert, AlertRule, NotificationChannel } from '@prisma/client';
import { getPrismaWriter, getPrismaReader } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { getLogger } from '../config/logger.js';
import {
  AlertEvaluator,
  RuleQuerySchema,
  type RuleQuery,
} from '../domains/alerts/alert.evaluator.js';
import { AlertDispatcher } from '../domains/alerts/alert.dispatcher.js';
import { writeAuditLog } from '../shared/middleware/audit-log.middleware.js';

const POLL_INTERVAL_MS = Number(process.env.ALERT_POLL_INTERVAL_MS ?? 30_000);
const LOCK_TTL_SECONDS = Number(process.env.ALERT_LOCK_TTL_SECONDS ?? 300);

export interface CycleSummary {
  evaluated: number;
  fired: number;
  resolved: number;
  skipped: number;
  errors: number;
}

/**
 * Run a single evaluation cycle. Exported for tests so we can drive it
 * deterministically without the poll loop.
 */
export async function runEvaluationCycle(opts: {
  evaluator: AlertEvaluator;
  dispatcher: AlertDispatcher;
  prisma: ReturnType<typeof getPrismaWriter>;
  reader: ReturnType<typeof getPrismaReader>;
  now?: Date;
  // If provided, used to short-circuit per-rule cadence checks (Redis-backed
  // in production; pass an in-memory map in tests).
  shouldEvaluate?: (rule: AlertRule, now: Date) => Promise<boolean>;
  markEvaluated?: (rule: AlertRule, now: Date) => Promise<void>;
}): Promise<CycleSummary> {
  const log = getLogger();
  const now = opts.now ?? new Date();
  const summary: CycleSummary = { evaluated: 0, fired: 0, resolved: 0, skipped: 0, errors: 0 };

  const rules = await opts.reader.alertRule.findMany({
    where: { isActive: true },
    include: { channel: true },
  });

  for (const rule of rules) {
    try {
      const shouldEval = opts.shouldEvaluate ? await opts.shouldEvaluate(rule, now) : true;
      if (!shouldEval) {
        summary.skipped += 1;
        continue;
      }

      // Validate the stored query against the DSL. A malformed rule throws
      // here; we surface the error rather than silently skipping so an op
      // sees the bad rule on the next /alerts page load.
      const parsed = RuleQuerySchema.parse(rule.query);
      const result = await opts.evaluator.evaluate(parsed, rule.windowMinutes);
      summary.evaluated += 1;

      if (opts.markEvaluated) await opts.markEvaluated(rule, now);

      // Find any existing non-resolved alert for this rule. We treat OPEN
      // and ACKNOWLEDGED as "still active" — only RESOLVED counts as cleared.
      const open = await opts.prisma.alert.findFirst({
        where: { ruleId: rule.id, state: { in: ['OPEN', 'ACKNOWLEDGED', 'SNOOZED'] } },
        orderBy: { firedAt: 'desc' },
      });

      if (result.hit && !open) {
        // New alert: create + dispatch.
        const created = await opts.prisma.alert.create({
          data: {
            id: uuidv7(),
            ruleId: rule.id,
            severity: rule.severity,
            state: 'OPEN',
            payload: {
              metric: result.metric,
              observed: result.observed,
              threshold: result.threshold,
              windowMinutes: result.windowMinutes,
              context: result.context,
              evaluatedAt: now.toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        await opts.dispatcher.dispatch(created, rule.channel as NotificationChannel | null);
        summary.fired += 1;
      } else if (!result.hit && open) {
        // Auto-resolve: rule went cool, clear the open alert.
        await opts.prisma.alert.update({
          where: { id: open.id },
          data: { state: 'RESOLVED', resolvedAt: now },
        });
        await writeAuditLog({
          action: 'ALERT_RESOLVED',
          resourceType: 'alert',
          resourceId: open.id,
          metadata: {
            ruleId: rule.id,
            metric: result.metric,
            observed: result.observed,
            threshold: result.threshold,
            autoResolved: true,
          },
        });
        summary.resolved += 1;
      }
      // else: hit && open  → already firing, no-op (no double-fire)
      //       !hit && !open → quiet, nothing to do
    } catch (err) {
      summary.errors += 1;
      log.error(
        { ruleId: rule.id, err: err instanceof Error ? err.message : String(err) },
        'alert.eval.error',
      );
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const log = getLogger();
  const prisma = getPrismaWriter();
  const reader = getPrismaReader();
  const redis = getRedis();
  const evaluator = new AlertEvaluator(reader);
  const dispatcher = new AlertDispatcher(prisma);

  log.info({ pollMs: POLL_INTERVAL_MS }, 'alert.worker.start');

  // Per-rule cadence + cross-replica locking via Redis. Two semantics:
  //   1. Cadence: we don't re-eval a rule until at least its windowMinutes
  //      have elapsed since the last eval. Stops a 60-min rule from
  //      double-firing if the worker pollInterval is 30s.
  //   2. Lock: SETNX on `alert:eval:<id>` so multiple worker replicas don't
  //      stampede the same rule. TTL is windowMinutes + safety margin.
  const shouldEvaluate = async (rule: AlertRule, now: Date): Promise<boolean> => {
    const lastKey = `alert:last:${rule.id}`;
    const lastIso = await redis.get(lastKey);
    if (lastIso) {
      const last = new Date(lastIso);
      const ageMs = now.getTime() - last.getTime();
      // Cadence floor: re-eval no more often than windowMinutes/2.
      if (ageMs < (rule.windowMinutes * 60_000) / 2) return false;
    }
    const lockKey = `alert:lock:${rule.id}`;
    const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    return acquired === 'OK';
  };

  const markEvaluated = async (rule: AlertRule, now: Date): Promise<void> => {
    await redis.set(`alert:last:${rule.id}`, now.toISOString(), 'EX', rule.windowMinutes * 120);
  };

  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'alert.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    try {
      const summary = await runEvaluationCycle({
        evaluator,
        dispatcher,
        prisma,
        reader,
        shouldEvaluate,
        markEvaluated,
      });
      if (summary.fired || summary.resolved || summary.errors) {
        log.info({ summary }, 'alert.cycle.done');
      } else {
        log.debug({ summary }, 'alert.cycle.done');
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'alert.cycle.error');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  await prisma.$disconnect();
  process.exit(0);
}

// Don't auto-run when imported by tests.
if (process.env.ALERT_WORKER_AUTORUN !== '0' && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export type { RuleQuery };
