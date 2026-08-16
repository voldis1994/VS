/** ATR / structure stops — explicit inputs only; no invented prices. */

export function atrStop(input: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  atr: number;
  multiplier: number;
  minDistance?: number;
}): { stop: number; distance: number } | { error: string } {
  if (!(input.entry > 0) || !(input.atr > 0) || !(input.multiplier > 0)) {
    return { error: 'INVALID_INPUT' };
  }
  let distance = input.atr * input.multiplier;
  if (input.minDistance != null) distance = Math.max(distance, input.minDistance);
  const stop =
    input.direction === 'LONG' ? input.entry - distance : input.entry + distance;
  if (!(stop > 0)) return { error: 'STOP_INVALID' };
  return { stop, distance };
}

export function riskRewardTarget(input: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  rewardMultiple: number;
}): { target: number } | { error: string } {
  if (!(input.entry > 0) || !(input.stop > 0) || !(input.rewardMultiple > 0)) {
    return { error: 'INVALID_INPUT' };
  }
  const risk =
    input.direction === 'LONG' ? input.entry - input.stop : input.stop - input.entry;
  if (!(risk > 0)) return { error: 'RISK_NON_POSITIVE' };
  const target =
    input.direction === 'LONG'
      ? input.entry + risk * input.rewardMultiple
      : input.entry - risk * input.rewardMultiple;
  return { target };
}

export function positionSize(input: {
  equity: number;
  riskFraction: number;
  entry: number;
  stop: number;
  direction: 'LONG' | 'SHORT';
}): { size: number } | { error: string } {
  if (!(input.equity > 0) || !(input.riskFraction > 0) || input.riskFraction > 1) {
    return { error: 'INVALID_RISK_BUDGET' };
  }
  const perUnit =
    input.direction === 'LONG' ? input.entry - input.stop : input.stop - input.entry;
  if (!(perUnit > 0)) return { error: 'INVALID_STOP_DISTANCE' };
  const riskAmount = input.equity * input.riskFraction;
  const size = riskAmount / perUnit;
  if (!(size > 0)) return { error: 'SIZE_INVALID' };
  return { size };
}
