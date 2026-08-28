/**
 * Fast entry: 1m candle displacement IS the move confirm.
 * Direction comes from the 1m candle itself — do NOT wait for 5m tape/BOS
 * (that was why entries were late: tape needs 5m already moving).
 */

import {
  analyzeMarketStructure,
  structuralStopLevel,
  thesisPivot,
  type StructureBar,
} from './marketStructure.js';
import { earlyDirectionBlockedByRegime } from './earlyEntryArmed.js';
import { isRealBar } from './ohlcQuality.js';
import { atrWilder, moveThresholdPts, type InstrumentMeta } from './volatilityNorm.js';
import type { HtfContext } from './fiveMinuteBrain.js';

export type OneMinMoveConfirm = {
  ok: boolean;
  detail: string;
  bar?: StructureBar;
  body_pts?: number;
  live?: boolean;
};

/** Closed REAL 1m bars (no forming). */
export function closedOneMinBars(bars1m: StructureBar[] | null | undefined): StructureBar[] {
  return (bars1m ?? []).filter((b) => isRealBar(b) && !b.forming);
}

/** Forming REAL 1m bar (live mid-candle confirm). */
export function formingOneMinBar(bars1m: StructureBar[] | null | undefined): StructureBar | null {
  const bars = bars1m ?? [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    if (isRealBar(b) && b.forming) return b;
  }
  return null;
}

function bodyConfirm(
  last: StructureBar,
  direction: 'BUY' | 'SELL',
  thr: number,
  live: boolean
): OneMinMoveConfirm {
  const range = Math.max(last.high - last.low, 1e-9);
  const body = last.close - last.open;

  if (direction === 'BUY') {
    // Live: slightly softer acceptance (move still building)
    const acceptFrac = live ? 0.2 : 0.25;
    if (body < thr) {
      return {
        ok: false,
        detail: `1m body +${body.toFixed(2)} < move thr ${thr.toFixed(2)}${live ? ' LIVE' : ''}`,
        bar: last,
        body_pts: body,
        live,
      };
    }
    if (last.close < last.open + range * acceptFrac) {
      return {
        ok: false,
        detail: '1m weak close · need acceptance',
        bar: last,
        body_pts: body,
        live,
      };
    }
    return {
      ok: true,
      detail: `1m MOVE BUY${live ? ' LIVE' : ''} · body +${body.toFixed(2)} · C=${last.close.toFixed(2)}`,
      bar: last,
      body_pts: body,
      live,
    };
  }

  const acceptFrac = live ? 0.2 : 0.25;
  if (-body < thr) {
    return {
      ok: false,
      detail: `1m body ${body.toFixed(2)} > -move thr ${thr.toFixed(2)}${live ? ' LIVE' : ''}`,
      bar: last,
      body_pts: body,
      live,
    };
  }
  if (last.close > last.open - range * acceptFrac) {
    return {
      ok: false,
      detail: '1m weak close · need acceptance',
      bar: last,
      body_pts: body,
      live,
    };
  }
  return {
    ok: true,
    detail: `1m MOVE SELL${live ? ' LIVE' : ''} · body ${body.toFixed(2)} · C=${last.close.toFixed(2)}`,
    bar: last,
    body_pts: body,
    live,
  };
}

/**
 * 1m displacement in trade direction.
 * Prefer closed bar; if allowLive, also accept forming candle with strong body
 * (catch the move mid-minute — closed-only was always late).
 */
export function oneMinMoveConfirm(
  bars1m: StructureBar[] | null | undefined,
  direction: 'BUY' | 'SELL',
  price: number,
  atr?: number | null,
  meta?: InstrumentMeta | null,
  opts?: { allowLive?: boolean }
): OneMinMoveConfirm {
  // Softer than 0.1 ATR — catch earlier on Gold micro moves
  const thr = moveThresholdPts(price, atr ?? null, 0.05, 0.00006, meta);
  if (thr == null) return { ok: false, detail: '1m move threshold UNKNOWN' };

  if (opts?.allowLive) {
    const live = formingOneMinBar(bars1m);
    if (live) {
      const liveHit = bodyConfirm(live, direction, thr, true);
      if (liveHit.ok) return liveHit;
    }
  }

  const closed = closedOneMinBars(bars1m);
  const last = closed[closed.length - 1];
  if (!last) return { ok: false, detail: 'no closed 1m bar' };
  return bodyConfirm(last, direction, thr, false);
}

/** Infer BUY/SELL from strongest 1m move (live preferred). */
export function directionFromOneMinMove(
  bars1m: StructureBar[] | null | undefined,
  price: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): { direction: 'BUY' | 'SELL'; confirm: OneMinMoveConfirm } | null {
  const buy = oneMinMoveConfirm(bars1m, 'BUY', price, atr, meta, { allowLive: true });
  const sell = oneMinMoveConfirm(bars1m, 'SELL', price, atr, meta, { allowLive: true });
  if (buy.ok && !sell.ok) return { direction: 'BUY', confirm: buy };
  if (sell.ok && !buy.ok) return { direction: 'SELL', confirm: sell };
  if (buy.ok && sell.ok) {
    const bb = Math.abs(buy.body_pts ?? 0);
    const sb = Math.abs(sell.body_pts ?? 0);
    return bb >= sb
      ? { direction: 'BUY', confirm: buy }
      : { direction: 'SELL', confirm: sell };
  }
  return null;
}

export type OneMinMoveEntryInput = {
  bars5m: StructureBar[];
  bars1m: StructureBar[];
  /** Optional — used only as soft bias / hard fight check, not required. */
  tape_dir?: 'BUY' | 'SELL' | null;
  regime?: string | null;
  htf?: HtfContext | null;
  price: number;
  spread?: number | null;
  broker_min_stop?: number | null;
  tick_size?: number | null;
  /**
   * Bar key already traded this cycle — skip (dedup).
   * Do NOT require "just closed" tick — that missed the move if other gates failed once.
   */
  already_fired_bar_key?: string | null;
};

export type OneMinMoveEntryResult = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK';
  reason: string;
  structural_sl: number;
  bar_key: string;
  live: boolean;
} | null;

/**
 * Fast entry: 1m MOVE defines direction. Soft 5m/HTF filters only.
 * No tape-first, no just-closed-only, no 5m anti-chase (those made entries late).
 */
export function decideOneMinMoveEntry(input: OneMinMoveEntryInput): OneMinMoveEntryResult {
  const bars5m = input.bars5m.filter((b) => isRealBar(b) && !b.forming);
  const atr =
    (bars5m.length >= 8 ? analyzeMarketStructure(bars5m).atr : null) ??
    atrWilder(bars5m, 14) ??
    atrWilder(closedOneMinBars(input.bars1m), 14);

  const meta = { tick_size: input.tick_size, point_size: input.tick_size };
  const hit = directionFromOneMinMove(input.bars1m, input.price, atr, meta);
  if (!hit) return null;

  const dir = hit.direction;
  const bar = hit.confirm.bar;
  if (!bar) return null;

  const barKey = String(bar.open_time_ms || 0);
  if (barKey && input.already_fired_bar_key && barKey === input.already_fired_bar_key) {
    return null;
  }

  // Hard fight only — soft RANGE / same-side OK
  const against = earlyDirectionBlockedByRegime(dir, input.regime, input.tape_dir ?? null);
  if (against) return null;

  if (bars5m.length >= 6) {
    const ms = analyzeMarketStructure(bars5m);
    if (dir === 'BUY' && ms.trend === 'DOWN') return null;
    if (dir === 'SELL' && ms.trend === 'UP') return null;
  }

  const htf = input.htf;
  if (htf?.trend === 'DOWN' && dir === 'BUY') return null;
  if (htf?.trend === 'UP' && dir === 'SELL') return null;

  // Soft tape fight: if tape clearly opposite, skip (not required same-side)
  if (input.tape_dir != null && input.tape_dir !== dir) return null;

  const ms =
    bars5m.length >= 6
      ? analyzeMarketStructure(bars5m)
      : analyzeMarketStructure(closedOneMinBars(input.bars1m));

  const sl = structuralStopLevel(dir, thesisPivot(ms, dir), {
    atr: ms.atr ?? atr,
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

  const live = Boolean(hit.confirm.live);
  return {
    direction: dir,
    setup,
    reason: `1M MOVE ${dir}${live ? ' LIVE' : ''} · ${hit.confirm.detail} · 5m ${ms.trend}`,
    structural_sl: sl,
    bar_key: barKey,
    live,
  };
}
