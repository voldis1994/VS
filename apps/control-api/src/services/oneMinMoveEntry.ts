/**
 * Fast entry: closed 1m candle displacement confirms the move.
 * Fires before full 5m BOS/CHoCH — tape + 5m trend + 1m MOVE (not zone micro 2/2).
 */

import {
  analyzeMarketStructure,
  structuralStopLevel,
  thesisPivot,
  type StructureBar,
} from './marketStructure.js';
import { blockLateChaseAdaptive } from './fiveMinuteBrain.js';
import { earlyDirectionBlockedByRegime } from './earlyEntryArmed.js';
import { isRealBar } from './ohlcQuality.js';
import { moveThresholdPts, type InstrumentMeta } from './volatilityNorm.js';
import type { HtfContext } from './fiveMinuteBrain.js';

export type OneMinMoveConfirm = {
  ok: boolean;
  detail: string;
  bar?: StructureBar;
  body_pts?: number;
};

/** Last closed REAL 1m bar only — forming candle must not confirm (#67). */
export function closedOneMinBars(bars1m: StructureBar[] | null | undefined): StructureBar[] {
  return (bars1m ?? []).filter((b) => isRealBar(b) && !b.forming);
}

/**
 * Closed 1m candle body displacement in trade direction.
 * Body must exceed move threshold; close must accept (upper/lower half of range).
 */
export function oneMinMoveConfirm(
  bars1m: StructureBar[] | null | undefined,
  direction: 'BUY' | 'SELL',
  price: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): OneMinMoveConfirm {
  const closed = closedOneMinBars(bars1m);
  const last = closed[closed.length - 1];
  if (!last) return { ok: false, detail: 'no closed 1m bar' };

  const thr = moveThresholdPts(price, atr ?? null, 0.1, 0.0001, meta);
  if (thr == null) return { ok: false, detail: '1m move threshold UNKNOWN' };

  const range = Math.max(last.high - last.low, 1e-9);
  const body = last.close - last.open;
  const bodyAbs = Math.abs(body);

  if (direction === 'BUY') {
    if (body < thr) {
      return {
        ok: false,
        detail: `1m body +${body.toFixed(2)} < move thr ${thr.toFixed(2)}`,
        bar: last,
        body_pts: body,
      };
    }
    if (last.close < last.open + range * 0.3) {
      return { ok: false, detail: '1m weak close · need acceptance upper range', bar: last, body_pts: body };
    }
    return {
      ok: true,
      detail: `1m MOVE BUY · body +${body.toFixed(2)} · C=${last.close.toFixed(2)}`,
      bar: last,
      body_pts: body,
    };
  }

  if (-body < thr) {
    return {
      ok: false,
      detail: `1m body ${body.toFixed(2)} > -move thr ${thr.toFixed(2)}`,
      bar: last,
      body_pts: body,
    };
  }
  if (last.close > last.open - range * 0.3) {
    return { ok: false, detail: '1m weak close · need acceptance lower range', bar: last, body_pts: body };
  }
  return {
    ok: true,
    detail: `1m MOVE SELL · body ${body.toFixed(2)} · C=${last.close.toFixed(2)}`,
    bar: last,
    body_pts: body,
  };
}

export type OneMinMoveEntryInput = {
  bars5m: StructureBar[];
  bars1m: StructureBar[];
  tape_dir: 'BUY' | 'SELL' | null;
  regime?: string | null;
  htf?: HtfContext | null;
  price: number;
  spread?: number | null;
  broker_min_stop?: number | null;
  tick_size?: number | null;
  /** Only fire on fresh 1m close — avoids re-entry same bar every tick. */
  one_min_just_closed?: boolean;
};

export type OneMinMoveEntryResult = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK';
  reason: string;
  structural_sl: number;
} | null;

/**
 * Tape-led fast entry: direction from tape, 5m trend must not fight, 1m closed MOVE confirms.
 */
export function decideOneMinMoveEntry(input: OneMinMoveEntryInput): OneMinMoveEntryResult {
  const dir = input.tape_dir;
  if (dir !== 'BUY' && dir !== 'SELL') {
    return null;
  }

  const against = earlyDirectionBlockedByRegime(dir, input.regime, dir);
  if (against) return null;

  const bars5m = input.bars5m.filter((b) => isRealBar(b) && !b.forming);
  if (bars5m.length < 6) return null;

  const ms = analyzeMarketStructure(bars5m);
  const atr = ms.atr ?? null;

  // 5m must not fight tape (allow RANGE / pullback)
  if (dir === 'BUY' && ms.trend === 'DOWN') return null;
  if (dir === 'SELL' && ms.trend === 'UP') return null;

  const htf = input.htf;
  if (htf?.trend === 'DOWN' && dir === 'BUY') return null;
  if (htf?.trend === 'UP' && dir === 'SELL') return null;

  const chase = blockLateChaseAdaptive(dir, bars5m, atr);
  if (!chase.ok) return null;

  if (input.one_min_just_closed !== true) return null;

  const move = oneMinMoveConfirm(input.bars1m, dir, input.price, atr, {
    tick_size: input.tick_size,
    point_size: input.tick_size,
  });
  if (!move.ok || !move.bar) return null;

  const sl = structuralStopLevel(dir, thesisPivot(ms, dir), {
    atr,
    spread: input.spread,
    brokerMinStop: input.broker_min_stop,
    price: input.price,
    tickSize: input.tick_size,
  });
  if (sl == null) return null;

  const setup: 'CONTINUATION' | 'PULLBACK' =
    (dir === 'BUY' && ms.trend === 'UP') || (dir === 'SELL' && ms.trend === 'DOWN')
      ? 'CONTINUATION'
      : 'PULLBACK';

  return {
    direction: dir,
    setup,
    reason: `1M MOVE ${dir} · tape confirm · 5m ${ms.trend} · ${move.detail}`,
    structural_sl: sl,
  };
}
