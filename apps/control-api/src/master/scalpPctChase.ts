/**
 * VS-System 10s SCALPING broker SL — 10% initial / 20% profit chase.
 * Soft trail (moneyExit) is software-only; this pushes Capital/MT4 stopLevel.
 */
import {
  capitalMinStopDistance,
  capitalSafeInitialStop,
  capitalSafeTrailingStop,
  effectiveMinStopDistance,
  formatInstrumentPrice,
  instrumentPipSize,
} from './capitalStop.js';

/** In profit: leave this fraction of the favorable move as cushion under/over mark. */
export const SCALP_LOCK_PCT = 0.2;

/** Flat/loss protective distance = this × entry price (GOLD 4400 → 440 pts). */
export const SCALP_INITIAL_SL_PCT = 0.1;

/** Min interval between chase modifies when SL level actually improves. */
export const SCALP_SL_CHASE_MIN_INTERVAL_MS = 3_000;

/** Absolute price distance for start SL (10% of entry). */
export function scalpInitialStopDistance(entry: number): number {
  const e = Number(entry);
  if (!Number.isFinite(e) || e <= 0) return NaN;
  return e * SCALP_INITIAL_SL_PCT;
}

/** Broker stop at open / flat: entry ± 10% of price. */
export function scalpInitialBrokerStop(input: {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  mark?: number | null;
  min_distance?: number | null;
}): number | null {
  const entry = Number(input.entry);
  const dist = scalpInitialStopDistance(entry);
  if (!Number.isFinite(dist) || dist <= 0) return null;
  return capitalSafeInitialStop({
    symbol: input.symbol,
    direction: input.direction,
    entry,
    distance: dist,
    mark: input.mark ?? entry,
    min_distance: input.min_distance,
  });
}

/**
 * Candidate broker SL from entry (always defined when entry/mark valid).
 * Flat or against → entry.
 * In profit → trail behind mark by lockPct × favorable move.
 */
export function scalpPctLockCandidateSl(input: {
  direction: 'BUY' | 'SELL';
  entry: number;
  livePrice: number;
  lockPct?: number;
}): number {
  const entry = Number(input.entry);
  const mark = Number(input.livePrice);
  const pctRaw = Number(input.lockPct ?? SCALP_LOCK_PCT);
  const pct =
    Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw <= 1 ? pctRaw : SCALP_LOCK_PCT;
  if (![entry, mark].every((n) => Number.isFinite(n) && n > 0)) return NaN;

  if (input.direction === 'BUY') {
    const favorable = mark - entry;
    if (!(favorable > 0)) return entry;
    return mark - pct * favorable;
  }
  const favorable = entry - mark;
  if (!(favorable > 0)) return entry;
  return mark + pct * favorable;
}

/**
 * Capital-chart stop for 10%/20% chase — legal AFTER formatting.
 * In profit: trail mark with lockPct cushion, floored to min-stop vs mark.
 * Flat/loss: Capital-safe protective stop from entry (10%).
 */
export function scalpPctLockBrokerStop(input: {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  livePrice: number;
  lockPct?: number;
  min_distance?: number | null;
}): number | null {
  const entry = Number(input.entry);
  const mark = Number(input.livePrice);
  if (![entry, mark].every((n) => Number.isFinite(n) && n > 0)) return null;

  const minD = effectiveMinStopDistance(input.symbol, input.min_distance);
  const favorable = input.direction === 'BUY' ? mark - entry : entry - mark;
  const inProfit = favorable > 0;

  if (!inProfit) {
    return scalpInitialBrokerStop({
      symbol: input.symbol,
      direction: input.direction,
      entry,
      mark,
      min_distance: minD,
    });
  }

  let raw = scalpPctLockCandidateSl({
    direction: input.direction,
    entry,
    livePrice: mark,
    lockPct: input.lockPct,
  });
  if (!Number.isFinite(raw)) {
    return scalpInitialBrokerStop({
      symbol: input.symbol,
      direction: input.direction,
      entry,
      mark,
      min_distance: minD,
    });
  }

  // Clamp to min vs live mark. Allow SL still on the "wrong" side of entry
  // while favorable < minD — that still chases from the wide never-naked stop.
  if (input.direction === 'BUY') {
    raw = Math.min(raw, mark - minD);
    if (mark - minD >= entry - 1e-12) {
      raw = Math.max(raw, entry);
    }
  } else {
    raw = Math.max(raw, mark + minD);
    if (mark + minD <= entry + 1e-12) {
      raw = Math.min(raw, entry);
    }
  }

  const distFromMark = input.direction === 'BUY' ? mark - raw : raw - mark;
  const safeDist = Math.max(distFromMark, minD);
  return capitalSafeTrailingStop({
    symbol: input.symbol,
    direction: input.direction,
    mark,
    distance: safeDist,
    existingSl: null,
    min_distance: minD,
  });
}

/** Improve-only check for chase vs live/local stop. */
export function scalpChaseIsImprovement(input: {
  direction: 'BUY' | 'SELL';
  candidate: number;
  current: number | null | undefined;
}): boolean {
  const cand = Number(input.candidate);
  if (!Number.isFinite(cand)) return false;
  const cur = input.current;
  if (cur == null || !Number.isFinite(cur) || cur === 0) return true;
  return input.direction === 'BUY' ? cand > cur + 1e-12 : cand < cur - 1e-12;
}

export {
  capitalMinStopDistance,
  formatInstrumentPrice,
  instrumentPipSize,
};
