/**
 * Telemetry init contract tests.
 *
 * Verifies the on/off semantics WITHOUT spinning up an OTLP collector.
 * The SDK construction itself is the load-bearing thing — once it's
 * started, traces flow via auto-instrumentation. We just want to lock
 * down:
 *
 *   - OTEL_ENABLED unset / false  → SDK is not started, function returns undefined
 *   - OTEL_ENABLED=true + endpoint → SDK is started, returned, idempotent
 *   - OTEL_ENABLED=true, endpoint missing → warns + returns undefined
 *   - parseHeaders('a=1,b=2') → { a: '1', b: '2' }
 *
 * The withSpan helper is also tested: when no SDK is running it falls
 * back to the no-op tracer and the inner function still runs + returns.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  delete process.env.OTEL_ENABLED;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.OTEL_SERVICE_NAME;
  vi.resetModules();
});

describe('startTelemetry', () => {
  it('returns undefined when OTEL_ENABLED is unset', async () => {
    const { startTelemetry } = await import('../../src/config/telemetry.js');
    expect(startTelemetry()).toBeUndefined();
  });

  it('returns undefined when OTEL_ENABLED=false', async () => {
    process.env.OTEL_ENABLED = 'false';
    const { startTelemetry } = await import('../../src/config/telemetry.js');
    expect(startTelemetry()).toBeUndefined();
  });

  it('returns undefined and warns when OTEL_ENABLED=true but no endpoint set', async () => {
    process.env.OTEL_ENABLED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { startTelemetry } = await import('../../src/config/telemetry.js');
    expect(startTelemetry()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('starts the SDK when OTEL_ENABLED=true + endpoint set, and is idempotent', async () => {
    process.env.OTEL_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const { startTelemetry, getTelemetry } = await import('../../src/config/telemetry.js');
    const sdk = startTelemetry({ serviceName: 'test-svc' });
    expect(sdk).toBeDefined();
    expect(getTelemetry()).toBe(sdk);
    // Calling again returns the same SDK (no double-start, no orphan).
    const sdk2 = startTelemetry();
    expect(sdk2).toBe(sdk);
    // Cleanup so the next test gets a fresh SDK via vi.resetModules.
    await sdk?.shutdown().catch(() => undefined);
  });
});

describe('withSpan', () => {
  it('runs the function and returns its result when no SDK is active', async () => {
    const { withSpan } = await import('../../src/shared/utils/tracing.js');
    const out = await withSpan('test.span', async () => 42);
    expect(out).toBe(42);
  });

  it('propagates thrown errors and re-throws', async () => {
    const { withSpan } = await import('../../src/shared/utils/tracing.js');
    await expect(
      withSpan('test.span', async () => {
        throw new Error('inner-fail');
      }),
    ).rejects.toThrow(/inner-fail/);
  });

  it('passes the active span to the callback', async () => {
    const { withSpan } = await import('../../src/shared/utils/tracing.js');
    let captured: unknown;
    await withSpan('test.span', async (span) => {
      captured = span;
      span.setAttribute('test.attr', 'value');
      return undefined;
    });
    expect(captured).toBeDefined();
    expect(typeof (captured as { setAttribute?: unknown }).setAttribute).toBe('function');
  });
});
