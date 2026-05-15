/**
 * Per-lender circuit breaker (Phase H).
 *
 * Three-state machine: CLOSED (normal) → OPEN (refusing calls) → HALF_OPEN
 * (one probe call). Following the classic Hystrix / resilience4j shape.
 *
 *   - CLOSED: every call passes through. Track success/failure ratio in
 *     a rolling window. If failure ratio > THRESHOLD over WINDOW_SIZE
 *     samples → trip to OPEN.
 *   - OPEN: every call rejected for OPEN_DURATION_MS. After the cooldown
 *     elapses → HALF_OPEN.
 *   - HALF_OPEN: one probe call allowed. Success → CLOSED, failure → OPEN
 *     (with the cooldown reset).
 *
 * Per-instance so each (process, lender-slug) tracks independently. The
 * polling worker keeps a map by lender slug.
 */

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Failures-out-of-WINDOW that trip the breaker. Default 0.5 (50%). */
  failureThreshold: number;
  /** Rolling-window sample count. Default 20. */
  windowSize: number;
  /** Cooldown duration in OPEN state before HALF_OPEN probe. Default 30s. */
  openDurationMs: number;
}

const DEFAULTS: CircuitBreakerOptions = {
  failureThreshold: 0.5,
  windowSize: 20,
  openDurationMs: 30_000,
};

export class CircuitBreaker {
  private state: State = 'CLOSED';
  private samples: Array<'ok' | 'fail'> = [];
  private openedAt = 0;
  // SEC-306 fix (Phase H round 2): a single probe-in-flight flag prevents
  // two concurrent pollers from each transitioning OPEN → HALF_OPEN on
  // the same tick and both hitting the (still-dead) adapter. Preserves
  // the breaker's "one probe call" contract under MAX_PARALLEL=8.
  private probeInFlight = false;

  constructor(
    public readonly name: string,
    private readonly opts: CircuitBreakerOptions = DEFAULTS,
  ) {}

  /** Returns true if the call MUST be skipped (breaker is OPEN). */
  shouldSkip(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt > this.opts.openDurationMs) {
        if (this.probeInFlight) return true;
        this.state = 'HALF_OPEN';
        this.probeInFlight = true;
        return false;
      }
      return true;
    }
    if (this.state === 'HALF_OPEN' && this.probeInFlight) return true;
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.samples = [];
      this.probeInFlight = false;
      return;
    }
    this.push('ok');
  }

  recordFailure(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.probeInFlight = false;
      return;
    }
    this.push('fail');
    if (this.samples.length >= this.opts.windowSize) {
      const failures = this.samples.filter((s) => s === 'fail').length;
      if (failures / this.samples.length >= this.opts.failureThreshold) {
        this.state = 'OPEN';
        this.openedAt = Date.now();
        this.samples = [];
      }
    }
  }

  getState(): State {
    return this.state;
  }

  private push(s: 'ok' | 'fail'): void {
    this.samples.push(s);
    if (this.samples.length > this.opts.windowSize) {
      this.samples.shift();
    }
  }
}

/**
 * Compute next-poll delay with exponential backoff + full jitter.
 * Maxes out at MAX_BACKOFF_MS to keep poll cadence bounded.
 *
 *   attempt 1 → 0..(base*1)ms
 *   attempt 2 → 0..(base*2)ms
 *   attempt 3 → 0..(base*4)ms
 *   ...
 *
 * "Full jitter" (AWS Architecture Blog 2015) spreads the herd more
 * evenly than equal-jitter for synchronised retries.
 */
export function backoffDelayMs(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const cap = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  return Math.floor(Math.random() * cap);
}
