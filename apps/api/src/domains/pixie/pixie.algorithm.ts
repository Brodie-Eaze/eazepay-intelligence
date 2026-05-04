/**
 * Pixie sliding-scale margin (pure function, fully unit-testable).
 *
 * Spec:
 *  - At collective volume ≥ breakpoint (default 25,000 pulls): per-pull cost = baseCost ($1)
 *  - Below breakpoint: cost slides linearly from `2 × baseCost` (at zero volume)
 *    down to `baseCost` (at breakpoint). Charge stays at baseCharge ($3) regardless.
 *  - Margin per pull = chargePerPull - costPerPull
 *  - Total = partnerPulls × marginPerPull
 *
 * Inputs use plain numbers — caller is responsible for Decimal conversion at the boundary.
 */
export interface PixieMarginInputs {
  collectivePulls: number;
  partnerPulls: number;
  breakpoint: number;
  baseCost: number;
  baseCharge: number;
}

export interface PixieMarginResult {
  costPerPull: string;
  chargePerPull: string;
  marginPerPull: string;
  total: string;
}

export function computePixieMargin(input: PixieMarginInputs): PixieMarginResult {
  const { collectivePulls, partnerPulls, breakpoint, baseCost, baseCharge } = input;
  if (breakpoint <= 0) throw new Error('breakpoint must be > 0');
  if (baseCost < 0 || baseCharge < 0) throw new Error('baseCost / baseCharge must be ≥ 0');

  let costPerPull: number;
  if (collectivePulls >= breakpoint) {
    costPerPull = baseCost;
  } else {
    const ratio = collectivePulls / breakpoint; // 0..1
    costPerPull = baseCost * (2 - ratio);
  }
  const marginPerPull = baseCharge - costPerPull;
  const total = marginPerPull * partnerPulls;

  return {
    costPerPull: costPerPull.toFixed(4),
    chargePerPull: baseCharge.toFixed(4),
    marginPerPull: marginPerPull.toFixed(4),
    total: total.toFixed(2),
  };
}
