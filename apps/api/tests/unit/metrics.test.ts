import { describe, expect, it, beforeEach } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  renderMetrics,
  __resetMetricsForTests,
} from '../../src/shared/metrics/metrics.js';

describe('metrics — counter', () => {
  beforeEach(() => __resetMetricsForTests());

  it('increments with labels and renders Prometheus format', () => {
    const c = new Counter('test_counter', 'A test counter.');
    c.inc({ status: '2xx' });
    c.inc({ status: '2xx' });
    c.inc({ status: '5xx' });
    const out = renderMetrics();
    expect(out).toContain('# HELP test_counter A test counter.');
    expect(out).toContain('# TYPE test_counter counter');
    expect(out).toContain('test_counter{status="2xx"} 2');
    expect(out).toContain('test_counter{status="5xx"} 1');
  });
});

describe('metrics — gauge', () => {
  beforeEach(() => __resetMetricsForTests());

  it('settable + last-write-wins', () => {
    const g = new Gauge('test_gauge', 'A test gauge.');
    g.set(5);
    g.set(7);
    g.set(3, { instance: 'a' });
    const out = renderMetrics();
    expect(out).toContain('test_gauge 7');
    expect(out).toContain('test_gauge{instance="a"} 3');
  });
});

describe('metrics — histogram', () => {
  beforeEach(() => __resetMetricsForTests());

  it('buckets observations + computes cumulative + sum + count', () => {
    const h = new Histogram('test_hist', 'A test histogram.', [0.1, 0.5, 1.0]);
    h.observe(0.05);
    h.observe(0.3);
    h.observe(2.0);
    const out = renderMetrics();
    // Cumulative counts: le=0.1 → 1 (0.05), le=0.5 → 2 (0.05+0.3),
    // le=1.0 → 2, le=+Inf → 3.
    expect(out).toContain('test_hist_bucket{le="0.1"} 1');
    expect(out).toContain('test_hist_bucket{le="0.5"} 2');
    expect(out).toContain('test_hist_bucket{le="1"} 2');
    expect(out).toContain('test_hist_bucket{le="+Inf"} 3');
    expect(out).toContain('test_hist_count 3');
  });

  it('startTimer + closure observation', async () => {
    const h = new Histogram('test_timer', 'Timer.', [0.001, 0.01]);
    const end = h.startTimer({ op: 'slow' });
    await new Promise((r) => setTimeout(r, 5));
    end();
    const out = renderMetrics();
    expect(out).toContain('test_timer_count{op="slow"} 1');
  });
});

describe('metrics — series cardinality cap', () => {
  beforeEach(() => __resetMetricsForTests());

  it('refuses new series past MAX_SERIES_PER_METRIC', () => {
    const c = new Counter('test_cardinality', 'cap test');
    // Push way past the 10k cap; expect renderMetrics to remain bounded.
    for (let i = 0; i < 10_050; i++) {
      c.inc({ id: String(i) });
    }
    const lines = renderMetrics()
      .split('\n')
      .filter((l) => l.startsWith('test_cardinality{'));
    expect(lines.length).toBeLessThanOrEqual(10_000);
  });
});
