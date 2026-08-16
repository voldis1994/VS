/** Structure / swing / volatility stops — explicit inputs; no invented prices. */

export type StopDecision = {
  method: 'STRUCTURE' | 'SWING' | 'VOLATILITY';
  stop: number;
  distance: number;
  finalStop: number;
  brokerMinApplied: boolean;
};

export function structureStop(input: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  structureLevel: number;
  buffer?: number;
  minDistance?: number;
}): StopDecision | { error: string } {
  if (!(input.entry > 0) || !(input.structureLevel > 0)) return { error: 'INVALID_INPUT' };
  const buffer = input.buffer ?? 0;
  let stop =
    input.direction === 'LONG'
      ? input.structureLevel - buffer
      : input.structureLevel + buffer;
  let distance = Math.abs(input.entry - stop);
  let brokerMinApplied = false;
  if (input.minDistance != null && distance < input.minDistance) {
    distance = input.minDistance;
    stop = input.direction === 'LONG' ? input.entry - distance : input.entry + distance;
    brokerMinApplied = true;
  }
  if (!(stop > 0) || !(distance > 0)) return { error: 'STOP_INVALID' };
  return { method: 'STRUCTURE', stop, distance, finalStop: stop, brokerMinApplied };
}

export function swingStop(input: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  swingLevel: number;
  minDistance?: number;
}): StopDecision | { error: string } {
  const r = structureStop({
    direction: input.direction,
    entry: input.entry,
    structureLevel: input.swingLevel,
    minDistance: input.minDistance,
  });
  if ('error' in r) return r;
  return { ...r, method: 'SWING' };
}

export function volatilityStop(input: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  volatility: number;
  multiplier: number;
  minDistance?: number;
}): StopDecision | { error: string } {
  if (!(input.entry > 0) || !(input.volatility > 0) || !(input.multiplier > 0)) {
    return { error: 'INVALID_INPUT' };
  }
  let distance = input.volatility * input.multiplier * input.entry;
  let brokerMinApplied = false;
  if (input.minDistance != null && distance < input.minDistance) {
    distance = input.minDistance;
    brokerMinApplied = true;
  }
  const stop =
    input.direction === 'LONG' ? input.entry - distance : input.entry + distance;
  if (!(stop > 0)) return { error: 'STOP_INVALID' };
  return { method: 'VOLATILITY', stop, distance, finalStop: stop, brokerMinApplied };
}
