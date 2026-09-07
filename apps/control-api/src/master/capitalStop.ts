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

/** Effective min-stop: max(soft pip floor, live dealingRules when present). */
export function effectiveMinStopDistance(
  symbol: string,
  liveMinStop?: number | null
): number {
  const soft = capitalMinStopDistance(symbol);
  const live =
    liveMinStop != null && Number.isFinite(liveMinStop) && liveMinStop > 0
      ? liveMinStop
      : 0;
  return Math.max(soft, live);
}

/** GOLD 2dp / FX 5dp — VS-System formatInstrumentPrice. */
export function formatInstrumentPrice(symbol: string, price: number | string): string {
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price);
  const s = String(symbol || '').toUpperCase();
  if (/XAU|GOLD|XAG|SILVER/.test(s)) return n.toFixed(2);
  if (/BTC|BITCOIN|ETH|ETHER/.test(s)) return n.toFixed(2);
  if (/JPY/.test(s)) return n.toFixed(3);
  if (/OIL|WTI|BRENT/.test(s)) return n.toFixed(2);
  if (/US100|US500|US30|NASDAQ|NDX|SPX|GER40|DE40|UK100|DOW/.test(s)) {
    return n.toFixed(1);
  }
  return n.toFixed(5);
}

/**
 * True when stop is on the correct side of mark with enough distance for Capital.
 */
export function stopValidVsMark(input: {
  side: 'BUY' | 'SELL';
  stop: number;
  mark: number;
  symbol: string;
  min_distance?: number | null;
}): boolean {
  const { stop, mark } = input;
  if (![stop, mark].every((n) => Number.isFinite(n))) return false;
  const minD = effectiveMinStopDistance(input.symbol, input.min_distance);
  if (input.side === 'BUY') return mark - stop >= minD * 0.98;
  return stop - mark >= minD * 0.98;
}

/**
 * Initial / recovery protective SL from entry (VS-System capitalSafeInitialStop).
 * Soft-floored to capital min; widens vs mark when needed.
 */
export function capitalSafeInitialStop(input: {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  distance: number;
  mark?: number | null;
  min_distance?: number | null;
}): number | null {
  const entry = Number(input.entry);
  const markRaw = input.mark != null ? Number(input.mark) : NaN;
  const mark = Number.isFinite(markRaw) && markRaw > 0 ? markRaw : entry;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const minD = effectiveMinStopDistance(input.symbol, input.min_distance);
  const pref = Number(input.distance);
  let dist = Number.isFinite(pref) && pref > 0 ? Math.max(pref, minD) : minD;

  if (input.direction === 'BUY') {
    let sl = entry - dist;
    // Widen if mark already through the stop
    if (mark <= sl + minD) sl = mark - minD;
    const formatted = Number(formatInstrumentPrice(input.symbol, sl));
    return Number.isFinite(formatted) ? formatted : sl;
  }
  let sl = entry + dist;
  if (mark >= sl - minD) sl = mark + minD;
  const formatted = Number(formatInstrumentPrice(input.symbol, sl));
  return Number.isFinite(formatted) ? formatted : sl;
}

/**
 * Trail SL that stays Capital-legal AFTER instrument price formatting.
 * GOLD 2dp rounding can reject mark−min — round SL *away* from mark until legal.
 */
export function capitalSafeTrailingStop(input: {
  symbol: string;
  direction: 'BUY' | 'SELL';
  mark: number;
  distance: number;
  existingSl?: number | null;
  min_distance?: number | null;
}): number | null {
  const mark = Number(input.mark);
  if (!Number.isFinite(mark) || mark <= 0) return null;
  const minDist = effectiveMinStopDistance(input.symbol, input.min_distance);
  const dist = Math.max(Number(input.distance) || 0, minDist);
  const pip = instrumentPipSize(input.symbol);
  const tick = Math.max(pip, 1e-8);

  if (input.direction === 'BUY') {
    let sl = mark - dist;
    let formatted = formatInstrumentPrice(input.symbol, sl);
    for (let i = 0; i < 10 && mark - Number(formatted) < minDist - 1e-12; i++) {
      sl = Number(formatted) - tick;
      formatted = formatInstrumentPrice(input.symbol, sl);
    }
    const existing = Number(input.existingSl);
    if (Number.isFinite(existing) && existing < mark && Number(formatted) < existing) {
      formatted = formatInstrumentPrice(input.symbol, existing);
    }
    const n = Number(formatted);
    return Number.isFinite(n) ? n : null;
  }

  let sl = mark + dist;
  let formatted = formatInstrumentPrice(input.symbol, sl);
  for (let i = 0; i < 10 && Number(formatted) - mark < minDist - 1e-12; i++) {
    sl = Number(formatted) + tick;
    formatted = formatInstrumentPrice(input.symbol, sl);
  }
  const existing = Number(input.existingSl);
  if (Number.isFinite(existing) && existing > mark && Number(formatted) > existing) {
    formatted = formatInstrumentPrice(input.symbol, existing);
  }
  const n = Number(formatted);
  return Number.isFinite(n) ? n : null;
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
  /** Live dealingRules min stop when known (overrides soft floor when larger) */
  min_distance?: number | null;
}): number | null {
  const minD = effectiveMinStopDistance(input.symbol, input.min_distance);
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
  if (
    !stopValidVsMark({
      side: input.side,
      stop,
      mark: input.mark,
      symbol: input.symbol,
      min_distance: minD,
    })
  ) {
    return null;
  }
  return stop;
}
