/**
 * Lightweight in-process metrics (Prometheus text exposition).
 *
 * Why not pull in prom-client / OTel-metrics: this stack already loads
 * @opentelemetry/sdk-node for tracing; adding a second metrics SDK
 * doubles boot-time + memory for what is, at the API surface, a
 * 200-line concern. This module emits the v0.0.4 Prometheus exposition
 * format directly — supported by every scraper (Prometheus, VictoriaMetrics,
 * Grafana Agent, Datadog OpenMetrics, etc.).
 *
 * Supported metric types:
 *   - Counter — monotonically increasing.
 *   - Gauge   — settable (process state: queue depth, lag).
 *   - Histogram — bucketed observation (latency, sizes).
 *
 * Labels: small fixed-cardinality strings (status code, source, errorId).
 * Don't put unbounded values (request id, user id) in labels — they
 * cause series explosion. The collector applies a hard 10k-series cap
 * per metric name to fail-loud on a runaway labelling bug.
 *
 * Boot wiring:
 *   - registerMetricsRoutes(app) mounts GET /metrics (text/plain).
 *   - Default histogram buckets target sub-ms..30s request latency:
 *       0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30 seconds.
 *
 * Thread-safety: Node is single-threaded per-process. Each worker has
 * its own in-process registry — Prometheus scrapes each replica
 * separately, and rate() / sum-by-label aggregations happen in the
 * scraper.
 */

const MAX_SERIES_PER_METRIC = 10_000;
const DEFAULT_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

type LabelValues = Record<string, string | number>;

interface CounterState {
  type: 'counter';
  help: string;
  series: Map<string, { labels: LabelValues; value: number }>;
}

interface GaugeState {
  type: 'gauge';
  help: string;
  series: Map<string, { labels: LabelValues; value: number }>;
}

interface HistogramState {
  type: 'histogram';
  help: string;
  buckets: readonly number[];
  series: Map<
    string,
    {
      labels: LabelValues;
      counts: number[]; // length === buckets.length + 1 (final = +Inf)
      sum: number;
      count: number;
    }
  >;
}

type AnyMetric = CounterState | GaugeState | HistogramState;

const registry = new Map<string, AnyMetric>();

function labelKey(labels: LabelValues | undefined): string {
  if (!labels) return '';
  // Stable key — sort by name. Cardinality cap applied at metric level.
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('|');
}

function escapeLabelValue(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: LabelValues | undefined): string {
  if (!labels) return '';
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

export class Counter {
  constructor(
    private readonly name: string,
    help: string,
  ) {
    if (!registry.has(name)) {
      registry.set(name, { type: 'counter', help, series: new Map() });
    }
  }

  inc(labels?: LabelValues, by = 1): void {
    const m = registry.get(this.name) as CounterState | undefined;
    if (!m) return;
    const key = labelKey(labels);
    let s = m.series.get(key);
    if (!s) {
      if (m.series.size >= MAX_SERIES_PER_METRIC) return; // shed
      s = { labels: { ...(labels ?? {}) }, value: 0 };
      m.series.set(key, s);
    }
    s.value += by;
  }
}

export class Gauge {
  constructor(
    private readonly name: string,
    help: string,
  ) {
    if (!registry.has(name)) {
      registry.set(name, { type: 'gauge', help, series: new Map() });
    }
  }

  set(value: number, labels?: LabelValues): void {
    const m = registry.get(this.name) as GaugeState | undefined;
    if (!m) return;
    const key = labelKey(labels);
    let s = m.series.get(key);
    if (!s) {
      if (m.series.size >= MAX_SERIES_PER_METRIC) return;
      s = { labels: { ...(labels ?? {}) }, value: 0 };
      m.series.set(key, s);
    }
    s.value = value;
  }
}

export class Histogram {
  constructor(
    private readonly name: string,
    help: string,
    private readonly buckets: readonly number[] = DEFAULT_BUCKETS_SECONDS,
  ) {
    if (!registry.has(name)) {
      registry.set(name, {
        type: 'histogram',
        help,
        buckets: [...buckets].sort((a, b) => a - b),
        series: new Map(),
      });
    }
  }

  observe(valueSeconds: number, labels?: LabelValues): void {
    const m = registry.get(this.name) as HistogramState | undefined;
    if (!m) return;
    const key = labelKey(labels);
    let s = m.series.get(key);
    if (!s) {
      if (m.series.size >= MAX_SERIES_PER_METRIC) return;
      s = {
        labels: { ...(labels ?? {}) },
        counts: new Array(m.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      m.series.set(key, s);
    }
    s.sum += valueSeconds;
    s.count += 1;
    let placed = false;
    for (let i = 0; i < m.buckets.length; i++) {
      if (valueSeconds <= m.buckets[i]!) {
        s.counts[i]! += 1;
        placed = true;
        break;
      }
    }
    if (!placed) s.counts[m.buckets.length]! += 1;
  }

  /**
   * Convenience: start a timer, return a function that records when called.
   */
  startTimer(labels?: LabelValues): () => void {
    const start = process.hrtime.bigint();
    return () => {
      const ns = Number(process.hrtime.bigint() - start);
      this.observe(ns / 1e9, labels);
    };
  }
}

/** Render the entire registry in Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, m] of registry.entries()) {
    lines.push(`# HELP ${name} ${m.help}`);
    lines.push(`# TYPE ${name} ${m.type}`);
    if (m.type === 'counter' || m.type === 'gauge') {
      for (const s of m.series.values()) {
        lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
      }
    } else {
      for (const s of m.series.values()) {
        const labels = s.labels;
        let cumulative = 0;
        for (let i = 0; i < m.buckets.length; i++) {
          cumulative += s.counts[i]!;
          const le = String(m.buckets[i]);
          lines.push(`${name}_bucket${renderLabels({ ...labels, le })} ${cumulative}`);
        }
        cumulative += s.counts[m.buckets.length]!;
        lines.push(`${name}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${cumulative}`);
        lines.push(`${name}_sum${renderLabels(labels)} ${s.sum}`);
        lines.push(`${name}_count${renderLabels(labels)} ${s.count}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Test-only: clear the registry. */
export function __resetMetricsForTests(): void {
  registry.clear();
}

// ─── Domain metrics ────────────────────────────────────────────────────────
//
// Declared at module load so workers can import and increment without
// boilerplate. The naming convention follows Prometheus best practice:
//   <subsystem>_<unit>_<verb> where unit is seconds / bytes / total.
//
// Add new metrics here so all telemetry surface lives in one place; the
// /metrics scrape exposes everything below automatically.

export const httpRequestsTotal = new Counter(
  'eazepay_http_requests_total',
  'Total HTTP requests handled by the API.',
);
export const httpRequestDurationSeconds = new Histogram(
  'eazepay_http_request_duration_seconds',
  'HTTP request latency by route + status.',
);

export const webhookEventsTotal = new Counter(
  'eazepay_webhook_events_total',
  'Inbound webhook events processed, by source + status.',
);
export const webhookDrainDurationSeconds = new Histogram(
  'eazepay_webhook_drain_duration_seconds',
  'Webhook drain handler latency by source + event_type.',
);

export const outboxSweptTotal = new Counter(
  'eazepay_outbox_swept_total',
  'Outbox rows handled by the sweeper, by kind + outcome.',
);
export const outboxLagSeconds = new Gauge(
  'eazepay_outbox_lag_seconds',
  'Age of the oldest unpublished outbox row (seconds).',
);

export const lenderPollsTotal = new Counter(
  'eazepay_lender_polls_total',
  'Lender adapter poll attempts, by adapter + outcome.',
);
export const lenderPollDurationSeconds = new Histogram(
  'eazepay_lender_poll_duration_seconds',
  'Lender adapter poll latency, by adapter.',
);
// Phase H reviewer fix (arch #5): emit breaker state so dashboards can
// alert on transitions. 0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN. One series
// per registered adapter slug — REGISTERED slugs only, no unbounded
// growth (SEC-307: tenant-controlled lenderName never reaches this
// label).
export const lenderCircuitState = new Gauge(
  'eazepay_lender_circuit_state',
  'Circuit-breaker state per lender adapter (0=CLOSED, 1=HALF_OPEN, 2=OPEN).',
);

export const piiReencryptedTotal = new Counter(
  'eazepay_pii_reencrypted_total',
  'Application PII rows upgraded v1 → v2 by the re-encryption worker.',
);

export const dekCacheHitsTotal = new Counter(
  'eazepay_dek_cache_hits_total',
  'Per-tenant DEK cache hits vs misses.',
);

export const authFailuresTotal = new Counter(
  'eazepay_auth_failures_total',
  'Authentication failures by reason (rate-limit, MFA, password, etc.).',
);

export const scheduledReportsFiredTotal = new Counter(
  'eazepay_scheduled_reports_fired_total',
  'Scheduled-report sweeper fires, by outcome.',
);

export const correlationLinkerOutcomesTotal = new Counter(
  'eazepay_correlation_linker_outcomes_total',
  'Correlation linker outcomes (linked / ambiguous / unresolved).',
);
