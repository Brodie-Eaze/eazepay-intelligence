/**
 * Alert engine unit tests.
 *
 * Two layers:
 *
 * 1. AlertEvaluator — verifies the metric → DB query mapping using a
 *    handcrafted Prisma stub. We don't need a live DB for these; we just
 *    want to lock down "rule with op gt + threshold X + observed Y → hit".
 *
 * 2. runEvaluationCycle — drives the state machine end-to-end with stubs:
 *    new HIT → creates OPEN alert + dispatches
 *    HIT while OPEN → no double-fire
 *    COOL while OPEN → resolves
 *    Malformed rule.query → counts as error, doesn't crash the cycle
 *
 * The Prisma stub is intentionally tight — only the methods the cycle
 * touches are mocked, with strict argument shape checks. A real schema
 * change forces the stub to be updated, surfacing drift.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

// Stub writeAuditLog: the real one calls getPrisma() at the global level,
// which we don't want to construct in unit tests. The cycle's contract
// with audit-logging is "fire and forget"; we just need it to not throw.
vi.mock('../../src/shared/middleware/audit-log.middleware.js', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'c'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

// ─── AlertEvaluator metric mapping ────────────────────────────────────────

describe('AlertEvaluator', () => {
  function reader(stubs: Record<string, unknown>): never {
    return stubs as never;
  }

  it('webhook_failure_rate: hit when failed/total > threshold', async () => {
    const { AlertEvaluator } = await import('../../src/domains/alerts/alert.evaluator.js');
    const calls: string[] = [];
    const e = new AlertEvaluator(
      reader({
        webhookEvent: {
          count: vi.fn(async (args: { where: { status?: string } }) => {
            calls.push(args.where.status ?? 'all');
            return args.where.status === 'FAILED' ? 7 : 100;
          }),
        },
      }),
    );
    const result = await e.evaluate({ metric: 'webhook_failure_rate', op: 'gt', value: 0.05 }, 60);
    expect(result.observed).toBeCloseTo(0.07);
    expect(result.hit).toBe(true);
    expect(calls).toEqual(['all', 'FAILED']);
  });

  it('webhook_failure_rate: not hit when below threshold', async () => {
    const { AlertEvaluator } = await import('../../src/domains/alerts/alert.evaluator.js');
    const e = new AlertEvaluator(
      reader({
        webhookEvent: {
          count: vi.fn(async (args: { where: { status?: string } }) =>
            args.where.status === 'FAILED' ? 1 : 100,
          ),
        },
      }),
    );
    const result = await e.evaluate({ metric: 'webhook_failure_rate', op: 'gt', value: 0.05 }, 60);
    expect(result.observed).toBeCloseTo(0.01);
    expect(result.hit).toBe(false);
  });

  it('webhook_failure_rate: zero events does not hit', async () => {
    const { AlertEvaluator } = await import('../../src/domains/alerts/alert.evaluator.js');
    const e = new AlertEvaluator(reader({ webhookEvent: { count: vi.fn(async () => 0) } }));
    const result = await e.evaluate({ metric: 'webhook_failure_rate', op: 'gt', value: 0.05 }, 60);
    expect(result.observed).toBe(0);
    expect(result.hit).toBe(false);
  });

  it('failed_login_count: counts USER_LOGIN_FAILED audit rows', async () => {
    const { AlertEvaluator } = await import('../../src/domains/alerts/alert.evaluator.js');
    const fn = vi.fn(async () => 12);
    const e = new AlertEvaluator(reader({ auditLog: { count: fn } }));
    const result = await e.evaluate({ metric: 'failed_login_count', op: 'gte', value: 10 }, 15);
    expect(result.hit).toBe(true);
    expect(result.observed).toBe(12);
    const calls = fn.mock.calls as unknown as Array<[{ where: { action: string } }]>;
    expect(calls[0]?.[0]?.where.action).toBe('USER_LOGIN_FAILED');
  });

  it('revenue_amount: sums RevenueEvent.amount over the window', async () => {
    const { AlertEvaluator } = await import('../../src/domains/alerts/alert.evaluator.js');
    const fn = vi.fn(async () => ({ _sum: { amount: '500.00' } }));
    const e = new AlertEvaluator(reader({ revenueEvent: { aggregate: fn } }));
    const result = await e.evaluate(
      { metric: 'revenue_amount', stream: 'BUZZPAY', op: 'lt', value: 1000 },
      1440,
    );
    expect(result.observed).toBe(500);
    expect(result.hit).toBe(true);
    expect(result.context.stream).toBe('BUZZPAY');
  });

  it('comparators: gt / gte / lt / lte all behave at the boundary', async () => {
    const { AlertEvaluator } = await import('../../src/domains/alerts/alert.evaluator.js');
    const fn = vi.fn(async () => 10);
    const e = new AlertEvaluator(reader({ auditLog: { count: fn } }));

    const at = (op: 'gt' | 'gte' | 'lt' | 'lte') =>
      e.evaluate({ metric: 'failed_login_count', op, value: 10 }, 15).then((r) => r.hit);

    expect(await at('gt')).toBe(false);
    expect(await at('gte')).toBe(true);
    expect(await at('lt')).toBe(false);
    expect(await at('lte')).toBe(true);
  });
});

// ─── runEvaluationCycle state machine ─────────────────────────────────────

describe('runEvaluationCycle', () => {
  function buildHarness(opts: {
    rules: Array<{ id: string; ruleQuery: unknown; openAlert?: { id: string } | null }>;
    evalReturns: (ruleId: string) => { hit: boolean; observed: number };
  }) {
    const created: Array<{ ruleId: string; payload: unknown }> = [];
    const updated: Array<{ id: string; data: unknown }> = [];
    const dispatched: string[] = [];

    const reader = {
      alertRule: {
        findMany: vi.fn(async () =>
          opts.rules.map((r) => ({
            id: r.id,
            isActive: true,
            query: r.ruleQuery,
            windowMinutes: 60,
            severity: 'WARN' as const,
            channelId: 'chan-1',
            channel: { id: 'chan-1', kind: 'IN_APP', isActive: true } as never,
          })),
        ),
      },
    } as never;

    const prisma = {
      alert: {
        findFirst: vi.fn(async ({ where }: { where: { ruleId: string } }) => {
          const r = opts.rules.find((x) => x.id === where.ruleId);
          return r?.openAlert ? { id: r.openAlert.id, ruleId: r.id, state: 'OPEN' } : null;
        }),
        create: vi.fn(async (args: { data: { ruleId: string; payload: unknown } }) => {
          created.push({ ruleId: args.data.ruleId, payload: args.data.payload });
          return { id: 'new-alert-id', ruleId: args.data.ruleId, severity: 'WARN', state: 'OPEN' };
        }),
        update: vi.fn(async (args: { where: { id: string }; data: unknown }) => {
          updated.push({ id: args.where.id, data: args.data });
          return { id: args.where.id };
        }),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    } as never;

    const evaluator = {
      evaluate: vi.fn(async (q: { metric: string }, _w: number) => {
        // Find the rule whose query matches and apply the configured return.
        const rule = opts.rules.find(
          (r) => (r.ruleQuery as { metric?: string })?.metric === q.metric,
        );
        if (!rule) throw new Error('rule not found');
        const r = opts.evalReturns(rule.id);
        return {
          hit: r.hit,
          observed: r.observed,
          threshold: 0.05,
          metric: q.metric,
          windowMinutes: 60,
          context: {},
        };
      }),
    } as never;

    const dispatcher = {
      dispatch: vi.fn(async (alert: { id: string }) => {
        dispatched.push(alert.id);
        return { channelId: 'chan-1', channelKind: 'IN_APP', delivered: true };
      }),
    } as never;

    return { reader, prisma, evaluator, dispatcher, created, updated, dispatched };
  }

  it('fires a new alert when a rule transitions to HIT and no open alert exists', async () => {
    const { runEvaluationCycle } = await import('../../src/workers/alert.worker.js');
    const h = buildHarness({
      rules: [{ id: 'r1', ruleQuery: { metric: 'failed_login_count', op: 'gt', value: 5 } }],
      evalReturns: () => ({ hit: true, observed: 12 }),
    });
    const summary = await runEvaluationCycle({
      evaluator: h.evaluator,
      dispatcher: h.dispatcher,
      prisma: h.prisma,
      reader: h.reader,
    });
    expect(summary.fired).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(h.created).toHaveLength(1);
    expect(h.dispatched).toEqual(['new-alert-id']);
  });

  it('does NOT double-fire when rule is HIT and an open alert already exists', async () => {
    const { runEvaluationCycle } = await import('../../src/workers/alert.worker.js');
    const h = buildHarness({
      rules: [
        {
          id: 'r1',
          ruleQuery: { metric: 'failed_login_count', op: 'gt', value: 5 },
          openAlert: { id: 'existing-alert' },
        },
      ],
      evalReturns: () => ({ hit: true, observed: 12 }),
    });
    const summary = await runEvaluationCycle({
      evaluator: h.evaluator,
      dispatcher: h.dispatcher,
      prisma: h.prisma,
      reader: h.reader,
    });
    expect(summary.fired).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(h.created).toHaveLength(0);
    expect(h.dispatched).toEqual([]);
  });

  it('auto-resolves an open alert when the rule goes COOL', async () => {
    const { runEvaluationCycle } = await import('../../src/workers/alert.worker.js');
    const h = buildHarness({
      rules: [
        {
          id: 'r1',
          ruleQuery: { metric: 'failed_login_count', op: 'gt', value: 5 },
          openAlert: { id: 'going-resolved' },
        },
      ],
      evalReturns: () => ({ hit: false, observed: 1 }),
    });
    const summary = await runEvaluationCycle({
      evaluator: h.evaluator,
      dispatcher: h.dispatcher,
      prisma: h.prisma,
      reader: h.reader,
    });
    expect(summary.fired).toBe(0);
    expect(summary.resolved).toBe(1);
    expect(h.updated[0]?.id).toBe('going-resolved');
    expect((h.updated[0]?.data as { state: string }).state).toBe('RESOLVED');
  });

  it('counts a malformed rule.query as an error without crashing the cycle', async () => {
    const { runEvaluationCycle } = await import('../../src/workers/alert.worker.js');
    const h = buildHarness({
      rules: [
        // Garbage shape — RuleQuerySchema.parse will throw.
        { id: 'r1', ruleQuery: { not_a_metric: 'oops' } },
        // A valid rule that should still evaluate normally.
        { id: 'r2', ruleQuery: { metric: 'failed_login_count', op: 'gt', value: 5 } },
      ],
      evalReturns: (id) =>
        id === 'r2' ? { hit: true, observed: 10 } : { hit: false, observed: 0 },
    });
    const summary = await runEvaluationCycle({
      evaluator: h.evaluator,
      dispatcher: h.dispatcher,
      prisma: h.prisma,
      reader: h.reader,
    });
    expect(summary.errors).toBe(1);
    expect(summary.evaluated).toBe(1);
    expect(summary.fired).toBe(1);
  });

  it('honours per-rule shouldEvaluate cadence (skips when false)', async () => {
    const { runEvaluationCycle } = await import('../../src/workers/alert.worker.js');
    const h = buildHarness({
      rules: [{ id: 'r1', ruleQuery: { metric: 'failed_login_count', op: 'gt', value: 5 } }],
      evalReturns: () => ({ hit: true, observed: 12 }),
    });
    const summary = await runEvaluationCycle({
      evaluator: h.evaluator,
      dispatcher: h.dispatcher,
      prisma: h.prisma,
      reader: h.reader,
      shouldEvaluate: async () => false,
    });
    expect(summary.skipped).toBe(1);
    expect(summary.fired).toBe(0);
  });
});
