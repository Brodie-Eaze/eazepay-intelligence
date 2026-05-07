/**
 * Alert rule evaluator.
 *
 * `AlertRule.query` is a declarative metric DSL — not arbitrary SQL — so a
 * misconfigured rule cannot exfiltrate or modify data. The evaluator
 * dispatches on the `metric` discriminator and runs a known, indexed query
 * against the read replica with the rule's `windowMinutes` as the lookback.
 *
 * Why a closed DSL instead of letting users write SQL?
 *   - SOC 2: every read path is auditable to a finite set of queries.
 *   - Safety: no path from a UI rule editor to `DROP TABLE`.
 *   - Indexability: each metric maps to a query with a known plan.
 *
 * Adding a new metric is one entry in `METRICS` plus its query.
 */
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

export const Comparator = z.enum(['gt', 'gte', 'lt', 'lte']);
export type Comparator = z.infer<typeof Comparator>;

export const RuleQuerySchema = z.discriminatedUnion('metric', [
  z.object({
    metric: z.literal('webhook_failure_rate'),
    op: Comparator,
    value: z.number().min(0).max(1),
  }),
  z.object({
    metric: z.literal('webhook_event_count'),
    source: z.enum(['BUZZPAY', 'PIXIE', 'MICAMP']).optional(),
    op: Comparator,
    value: z.number().int().min(0),
  }),
  z.object({
    metric: z.literal('failed_login_count'),
    op: Comparator,
    value: z.number().int().min(0),
  }),
  z.object({
    metric: z.literal('application_count'),
    status: z.string().optional(),
    op: Comparator,
    value: z.number().int().min(0),
  }),
  z.object({
    metric: z.literal('revenue_amount'),
    stream: z.enum(['BUZZPAY', 'PIXIE', 'MICAMP']).optional(),
    op: Comparator,
    value: z.number().min(0),
  }),
  z.object({
    metric: z.literal('pii_access_count'),
    op: Comparator,
    value: z.number().int().min(0),
  }),
  z.object({
    metric: z.literal('ingestion_rejected_count'),
    op: Comparator,
    value: z.number().int().min(0),
  }),
  z.object({
    metric: z.literal('replication_lag_ms'),
    op: Comparator,
    value: z.number().min(0),
  }),
]);
export type RuleQuery = z.infer<typeof RuleQuerySchema>;

export interface EvaluationResult {
  hit: boolean;
  observed: number;
  threshold: number;
  metric: string;
  windowMinutes: number;
  context: Record<string, unknown>;
}

/**
 * Compare an observed metric value against the rule's threshold.
 * Centralised so adding a new comparator (≠, between) lands in one place.
 */
function compare(observed: number, op: Comparator, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return observed > threshold;
    case 'gte':
      return observed >= threshold;
    case 'lt':
      return observed < threshold;
    case 'lte':
      return observed <= threshold;
  }
}

export class AlertEvaluator {
  /**
   * Reader is the production read replica (or writer fallback). Evaluator
   * never writes — it just queries metrics. Routing here mirrors the rest
   * of the analytics surface.
   */
  constructor(private readonly reader: PrismaClient) {}

  async evaluate(query: RuleQuery, windowMinutes: number): Promise<EvaluationResult> {
    const since = new Date(Date.now() - windowMinutes * 60_000);
    let observed: number;
    const context: Record<string, unknown> = {};

    switch (query.metric) {
      case 'webhook_failure_rate': {
        const [total, failed] = await Promise.all([
          this.reader.webhookEvent.count({ where: { receivedAt: { gte: since } } }),
          this.reader.webhookEvent.count({
            where: { receivedAt: { gte: since }, status: 'FAILED' },
          }),
        ]);
        observed = total === 0 ? 0 : failed / total;
        context.total = total;
        context.failed = failed;
        break;
      }
      case 'webhook_event_count': {
        observed = await this.reader.webhookEvent.count({
          where: {
            receivedAt: { gte: since },
            ...(query.source ? { source: query.source } : {}),
          },
        });
        if (query.source) context.source = query.source;
        break;
      }
      case 'failed_login_count': {
        observed = await this.reader.auditLog.count({
          where: { action: 'USER_LOGIN_FAILED', createdAt: { gte: since } },
        });
        break;
      }
      case 'application_count': {
        observed = await this.reader.application.count({
          where: {
            createdAt: { gte: since },
            ...(query.status ? { status: query.status as never } : {}),
          },
        });
        if (query.status) context.status = query.status;
        break;
      }
      case 'revenue_amount': {
        const result = await this.reader.revenueEvent.aggregate({
          where: {
            effectiveAt: { gte: since },
            ...(query.stream ? { stream: query.stream } : {}),
          },
          _sum: { amount: true },
        });
        observed = Number(result._sum.amount ?? 0);
        if (query.stream) context.stream = query.stream;
        break;
      }
      case 'pii_access_count': {
        observed = await this.reader.auditLog.count({
          where: { action: 'PII_ACCESSED', createdAt: { gte: since } },
        });
        break;
      }
      case 'ingestion_rejected_count': {
        observed = await this.reader.auditLog.count({
          where: { action: 'INGESTION_REJECTED', createdAt: { gte: since } },
        });
        break;
      }
      case 'replication_lag_ms': {
        // Reuses the same probe the readiness check uses — single source of
        // truth for lag measurement.
        const rows = await this.reader.$queryRawUnsafe<Array<{ lag_ms: number | null }>>(
          `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms`,
        );
        const lagMs = rows[0]?.lag_ms;
        // On the primary the function returns NULL — treat as 0 lag.
        observed = lagMs == null ? 0 : Number(lagMs);
        break;
      }
    }

    return {
      hit: compare(observed, query.op, query.value),
      observed,
      threshold: query.value,
      metric: query.metric,
      windowMinutes,
      context,
    };
  }
}
