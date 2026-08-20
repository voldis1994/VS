/**
 * OHLC adapter: desk tenSecondOhlc ↔ canonical market-intelligence 10s.
 * Do NOT invent a third builder — one canonical (MI), one desk adapter shape.
 */

import {
  updateTenSecondOhlc,
  type TenSecBar,
  type TenSecState,
} from './tenSecondOhlc.js';
import type { ValidatedTick } from './tickMicroEngine.js';

/**
 * Feed a validated tick into the desk 10s OHLC adapter (same UTC 10s buckets).
 * Canonical MI `ingestTickTo10s` is the long-term builder; this keeps robotDesk
 * on TenSecBar without a parallel third OHLC engine.
 */
export function ingestValidatedTickToDeskOhlc(
  state: TenSecState,
  tick: ValidatedTick
): { state: TenSecState; closed: TenSecBar | null } {
  if (!Number.isFinite(tick.mid) || tick.mid <= 0) {
    return { state, closed: null };
  }
  if (tick.quality === 'ERROR' || tick.quality === 'STALE') {
    return { state, closed: null };
  }
  const next = updateTenSecondOhlc(state, tick.mid, tick.ts_ms);
  const closed = next.just_closed && next.last_closed ? next.last_closed : null;
  return { state: next, closed };
}

/** Documented mapping: MI Candle10s → desk TenSecBar (when MI path is wired). */
export function candle10sToTenSecBar(c: {
  start_ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_count: number;
}): TenSecBar | null {
  const open_time_ms = Date.parse(c.start_ts);
  if (!Number.isFinite(open_time_ms)) return null;
  if (![c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0)) {
    return null;
  }
  return {
    open_time_ms,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    ticks: Math.max(1, c.tick_count || 1),
  };
}
