/**
 * Manual tracing helpers.
 *
 * Auto-instrumentation handles HTTP, DB, Redis, BullMQ. For business
 * operations (rule evaluation, RTBF processing, ingestion) we want named
 * spans so a Datadog/Honeycomb dashboard can answer "how long does an RTBF
 * take?" without correlating dozens of low-level spans.
 *
 * Usage:
 *
 *   await withSpan('alert.evaluate', async (span) => {
 *     span.setAttribute('rule.metric', query.metric);
 *     return doWork();
 *   });
 *
 * When telemetry is disabled (no SDK started), `withSpan` falls back to
 * just calling the function — no overhead beyond a `tracer.startSpan` /
 * `span.end()` pair on a no-op tracer.
 *
 * SOC 2 mapping: CC4.1 (monitoring), CC7.2 (operational evaluation).
 */
import { trace, SpanStatusCode, type Span, type SpanOptions } from '@opentelemetry/api';

const TRACER_NAME = 'eazepay-intelligence';

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Synchronous variant for hot paths where we don't want to allocate a
 * promise. Less common in this codebase.
 */
export function withSpanSync<T>(name: string, fn: (span: Span) => T): T {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
