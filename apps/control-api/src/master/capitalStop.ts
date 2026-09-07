/**
 * VS-System Capital min-stop helpers — trail/BE must stay broker-legal vs mark.
 */

export function instrumentPipSize(symbol: string): number {
  const s = String(symbol || '').toUpperCase();
  if (/XAU|GOLD|XAG|SILVER/.test(s)) return 0.01;
  if (/BTC|BITCOIN|ETH|ETHER/.test(s)) return 0.01;
  if (/JPY/.test(s)) return 0.001;
  if (/OIL|WTI|BRENT/.test(s)) return 0.01;
  if (/US100|US500|US30|NASDAQ|NDX|SPX|GER40|DE40|UK100|DOW/.test(s)) return 0.1;
  return 0.0001;
}

/** Softest Capital distance for stop validity (VS-System capitalMinStopDistance). */
export function capitalMinStopDistance(symbol: string): number {
  const pip = instrumentPipSize(symbol);
  return Math.max(pip * 2, pip);
}

/**
 * True when stop is on the correct side of mark with enough distance for Capital.
 */
export function stopValidVsMark(input: {
  side: 'BUY' | 'SELL';
  stop: number;
  mark: number;
  symbol: string;
}): boolean {
  const { stop, mark } = input;
  if (![stop, mark].every((n) => Number.isFinite(n))) return false;
  const minD = capitalMinStopDistance(input.symbol);
  if (input.side === 'BUY') return mark - stop >= minD * 0.98;
  return stop - mark >= minD * 0.98;
}

/**
 * Clamp a proposed trail/BE stop so Capital can accept it.
 * BUY: stop ≤ mark − minDist; SELL: stop ≥ mark + minDist.
 * Returns null if clamping would loosen past current stop (caller skips).
 */
export function clampStopForCapitalMark(input: {
  side: 'BUY' | 'SELL';
  stop: number;
  mark: number;
  symbol: string;
  current_stop?: number | null;
}): number | null {
  const minD = capitalMinStopDistance(input.symbol);
  let stop = input.stop;
  if (input.side === 'BUY') {
    const maxStop = input.mark - minD;
    if (!(maxStop > 0) || !Number.isFinite(maxStop)) return null;
    if (stop > maxStop) stop = maxStop;
    if (input.current_stop != null && stop <= input.current_stop) return null;
    if (stop >= input.mark) return null;
  } else {
    const minStop = input.mark + minD;
    if (!Number.isFinite(minStop)) return null;
    if (stop < minStop) stop = minStop;
    if (input.current_stop != null && stop >= input.current_stop) return null;
    if (stop <= input.mark) return null;
  }
  if (!stopValidVsMark({
    side: input.side,
    stop,
    mark: input.mark,
    symbol: input.symbol,
  })) {
    return null;
  }
  return stop;
}
