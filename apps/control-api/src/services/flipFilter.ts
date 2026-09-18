/** After a closed trade, next entry must flip direction (all regimes). */

export type TradeSide = 'BUY' | 'SELL';

/** True when signal matches the last closed side — block entry. */
export function sameDirectionBlocked(
  signal: TradeSide | null | undefined,
  lastClosedSide: TradeSide | null | undefined
): boolean {
  if (!signal || !lastClosedSide) return false;
  return signal === lastClosedSide;
}

/** Required opposite side after a close, or null if no prior close. */
export function requiredFlipSide(
  lastClosedSide: TradeSide | null | undefined
): TradeSide | null {
  if (lastClosedSide === 'BUY') return 'SELL';
  if (lastClosedSide === 'SELL') return 'BUY';
  return null;
}

export function flipFilterReason(
  signal: TradeSide,
  lastClosedSide: TradeSide
): string {
  return `FLIP FILTER · last closed ${lastClosedSide} · next must be ${
    lastClosedSide === 'BUY' ? 'SELL' : 'BUY'
  } · blocked ${signal}`;
}
