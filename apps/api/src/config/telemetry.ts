/**
 * OpenTelemetry initialization.
 *
 * Loaded as the FIRST module in every entry point (api, every worker).
 * The auto-instrumentations hook into Node's `require` to wrap pg,
 * ioredis, fastify, http, dns at construction time — they have to run
 * before those modules import.
 *
 * What gets traced
 *   - Every Fastify HTTP request (URL, method, status, latency, route name)
 *   - Every Postgres query via `pg` instrumentation (query text + duration)
 *   - Every Redis command via `ioredis` instrumentation
 *   - BullMQ job lifecycle (start, end, fail) via the auto-instrumentation
 *     bundle's `bullmq` module
 *   - Outbound `fetch` (delivery worker, Slack/webhook fan-out)
 *
 * Trace context propagation
 *   - W3C Trace Context (`traceparent`/`tracestate`) headers across HTTP
 *   - BullMQ jobs carry the parent context in `job.data` via the
 *     instrumentation; downstream worker spans link back automatically
 *
 * Exporter
 *   - OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT — the de facto standard
 *     and what every APM vendor (Datadog, Honeycomb, NewRelic, Grafana
 *     Tempo, Jaeger) accepts. No vendor lock-in.
 *   - When OTEL_ENABLED=false (default in dev/test), the SDK is not
 *     started — zero overhead, zero outbound network.
 *
 * SOC 2 mapping
 *   - CC4.1 — ongoing monitoring of system performance + errors
 *   - CC7.2 — operational anomaly detection via trace + log correlation
 *   - A1.2  — every request traceable end-to-end across processes
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

interface TelemetryStartOpts {
  /** Override the service name (defaults to OTEL_SERVICE_NAME or `eazepay-intelligence-api`). */
  serviceName?: string;
}

/**
 * Initialise telemetry. Idempotent — repeated calls return the existing SDK.
 * Called from each entry point with a per-process service name (api,
 * worker:webhook, worker:lifecycle, …) so traces show which process emitted
 * each span.
 */
export function startTelemetry(opts: TelemetryStartOpts = {}): NodeSDK | undefined {
  if (sdk) return sdk;

  const enabled = (process.env.OTEL_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) return undefined;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // eslint-disable-next-line no-console
    console.warn(
      '[telemetry] OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is unset; skipping init',
    );
    return undefined;
  }

  const serviceName =
    opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'eazepay-intelligence-api';

  // Headers: comma-separated `k=v` list, per OTLP spec.
  const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    ...(headers ? { headers } : {}),
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable filesystem tracing — far too noisy + leaks paths.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // DNS spans rarely useful in this stack.
        '@opentelemetry/instrumentation-dns': { enabled: false },
        // Redis + Postgres are the highest-value spans for this platform.
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
      }),
      // Fastify instrumentation moved out of the auto bundle in 0.75+ —
      // register it explicitly. Adds 1 span per route which is the
      // money-maker for understanding p99 by route.
      new FastifyInstrumentation(),
    ],
  });

  sdk.start();

  // Graceful shutdown — flush spans before exit so we don't lose the last
  // few seconds when an orchestrator drains the pod.
  process.on('SIGTERM', () => {
    void sdk?.shutdown().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[telemetry] shutdown error', err);
    });
  });

  return sdk;
}

export function getTelemetry(): NodeSDK | undefined {
  return sdk;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const [k, ...rest] = part.split('=');
    if (k && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
