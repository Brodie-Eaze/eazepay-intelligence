import { describe, expect, it } from 'vitest';
import { computePixieMargin } from '../../src/domains/pixie/pixie.algorithm.js';

describe('computePixieMargin', () => {
  it('above breakpoint: $2 margin per pull', () => {
    const r = computePixieMargin({
      collectivePulls: 30_000,
      partnerPulls: 1_000,
      breakpoint: 25_000,
      baseCost: 1,
      baseCharge: 3,
    });
    expect(r.costPerPull).toBe('1.0000');
    expect(r.marginPerPull).toBe('2.0000');
    expect(r.total).toBe('2000.00');
  });

  it('below breakpoint: cost slides linearly', () => {
    const r = computePixieMargin({
      collectivePulls: 12_500,
      partnerPulls: 100,
      breakpoint: 25_000,
      baseCost: 1,
      baseCharge: 3,
    });
    // ratio = 0.5 → cost = 1 * (2 - 0.5) = 1.5; margin = 3 - 1.5 = 1.5
    expect(r.costPerPull).toBe('1.5000');
    expect(r.marginPerPull).toBe('1.5000');
    expect(r.total).toBe('150.00');
  });

  it('zero collective volume → maximum subsidy (cost = 2x base)', () => {
    const r = computePixieMargin({
      collectivePulls: 0,
      partnerPulls: 10,
      breakpoint: 25_000,
      baseCost: 1,
      baseCharge: 3,
    });
    expect(r.costPerPull).toBe('2.0000');
    expect(r.marginPerPull).toBe('1.0000');
    expect(r.total).toBe('10.00');
  });

  it('rejects invalid inputs', () => {
    expect(() => computePixieMargin({ collectivePulls: 0, partnerPulls: 0, breakpoint: 0, baseCost: 1, baseCharge: 3 })).toThrow();
    expect(() => computePixieMargin({ collectivePulls: 0, partnerPulls: 0, breakpoint: 1, baseCost: -1, baseCharge: 3 })).toThrow();
  });
});
