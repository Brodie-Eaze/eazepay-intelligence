import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  backoffDelayMs,
} from '../../src/domains/lenders/adapter/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts CLOSED, allows calls', () => {
    const b = new CircuitBreaker('test');
    expect(b.shouldSkip()).toBe(false);
    expect(b.getState()).toBe('CLOSED');
  });

  it('trips to OPEN when failure threshold crossed', () => {
    const b = new CircuitBreaker('test', {
      failureThreshold: 0.5,
      windowSize: 4,
      openDurationMs: 10_000,
    });
    // 1 ok, then 3 fails — ratio 0.75 over window of 4 → trip.
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('OPEN');
    expect(b.shouldSkip()).toBe(true);
  });

  it('flips to HALF_OPEN after openDurationMs', async () => {
    const b = new CircuitBreaker('test', {
      failureThreshold: 0.5,
      windowSize: 2,
      openDurationMs: 30,
    });
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('OPEN');
    await new Promise((r) => setTimeout(r, 50));
    // shouldSkip side-effects the transition to HALF_OPEN.
    expect(b.shouldSkip()).toBe(false);
    expect(b.getState()).toBe('HALF_OPEN');
  });

  it('HALF_OPEN → CLOSED on a successful probe', async () => {
    const b = new CircuitBreaker('test', {
      failureThreshold: 0.5,
      windowSize: 2,
      openDurationMs: 10,
    });
    b.recordFailure();
    b.recordFailure();
    await new Promise((r) => setTimeout(r, 20));
    b.shouldSkip(); // transitions OPEN → HALF_OPEN
    b.recordSuccess();
    expect(b.getState()).toBe('CLOSED');
  });

  it('HALF_OPEN → OPEN on a failed probe', async () => {
    const b = new CircuitBreaker('test', {
      failureThreshold: 0.5,
      windowSize: 2,
      openDurationMs: 10,
    });
    b.recordFailure();
    b.recordFailure();
    await new Promise((r) => setTimeout(r, 20));
    b.shouldSkip();
    b.recordFailure();
    expect(b.getState()).toBe('OPEN');
  });
});

describe('backoffDelayMs — exponential with full jitter', () => {
  it('caps at maxMs regardless of attempt', () => {
    const max = 5_000;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const d = backoffDelayMs(attempt, 1_000, max);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(max);
    }
  });

  it('never returns negative', () => {
    expect(backoffDelayMs(0)).toBeGreaterThanOrEqual(0);
    expect(backoffDelayMs(-1)).toBeGreaterThanOrEqual(0);
  });
});
