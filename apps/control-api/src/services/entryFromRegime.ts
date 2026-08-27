/**
 * Entry facade — canonical path is fiveMinuteBrain (5m authoritative).
 * Keeps legacy helpers for BO / tape / tests.
 */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import {
  buildScalpZone,
  formatZoneInfo,
  type ScalpZone,
  type ZoneSetup,
} from './zones.js';
import {
  aggregateTenSecToFiveMin,
  aggregateTenSecToOneMin,
  decideFiveMinuteEntry,
  decideFromLtfAlone,
  blockLateChaseAdaptive,
  type BrainSetup,
} from './fiveMinuteBrain.js';
import type { StructureBar } from './marketStructure.js';
import { allowMicrostructureFromBars } from './ohlcQuality.js';
import { atrWilder } from './volatilityNorm.js';
import {
  advanceEarlyEntryArmed,
  idleArmedState,
  type ArmedTriggerState,
  type EarlyEntrySignal,
} from './earlyEntryArmed.js';
export type { ArmedTriggerState, EarlyEntrySignal };
export { idleArmedState, advanceEarlyEntryArmed };

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL' | 'SWEEP_RECLAIM' | 'FAILED_BREAKOUT';
  reason: string;
  zone?: ScalpZone | null;
  zone_setup?: ZoneSetup | null;
  structural_sl?: number | null;
  evidence_score?: number;
};

function isGreen(bar: TenSecBar): boolean {
  return bar.close > bar.open;
}

function isRed(bar: TenSecBar): boolean {
  return bar.close < bar.open;
}

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Late chase on LTF — relative body, not Gold pt. */
const LATE_SIGNAL_BODY_PCT = 0.0012;

export function signalBarTooLate(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= LATE_SIGNAL_BODY_PCT;
}

export function recentImpulse(
  bars: TenSecBar[] | null | undefined,
  lookback = 6
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  if (!bars?.length) return { dir: null, netPct: 0, netPts: 0 };
  const window = bars.slice(-Math.max(lookback, 2));
  if (window.length < 2) return { dir: null, netPct: 0, netPts: 0 };
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const netPts = last.close - first.open;
  const mid = Math.max(Math.abs(first.open), 1e-9);
  const netPct = netPts / mid;
  if (netPct >= 0.0008) return { dir: 'UP', netPct, netPts };
  if (netPct <= -0.0008) return { dir: 'DOWN', netPct, netPts };
  return { dir: null, netPct, netPts };
}

function withLive(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): TenSecBar[] {
  const all = [...(bars ?? [])];
  if (liveBar && Number.isFinite(liveBar.close)) {
    const last = all[all.length - 1];
    if (!last || last.open_time_ms !== liveBar.open_time_ms) all.push(liveBar);
    else all[all.length - 1] = liveBar;
  }
  return all;
}

export function shortNetMove(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  return recentImpulse(withLive(bars, liveBar), 9);
}

export function tenMinTape(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  return recentImpulse(withLive(bars, liveBar), 30);
}

export function selloffFromSwingHigh(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dumpPts: number; dumpPct: number } {
  const s = shortNetMove(bars, liveBar);
  if (s.netPct >= 0) return { dumpPts: 0, dumpPct: 0 };
  return { dumpPts: -s.netPts, dumpPct: -s.netPct };
}

export function rallyFromSwingLow(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { rallyPts: number; rallyPct: number } {
  const s = shortNetMove(bars, liveBar);
  if (s.netPct <= 0) return { rallyPts: 0, rallyPct: 0 };
  return { rallyPts: s.netPts, rallyPct: s.netPct };
}

export function structNetMove(
  bars: TenSecBar[] | null | undefined,
  lookback = 24
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  if (!bars?.length) return { dir: null, netPct: 0, netPts: 0 };
  const window = bars.slice(-Math.max(lookback, 8));
  if (window.length < 8) return { dir: null, netPct: 0, netPts: 0 };
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const netPts = last.close - first.open;
  const mid = Math.max(Math.abs(first.open), 1e-9);
  const netPct = netPts / mid;
  if (netPct >= 0.001) return { dir: 'UP', netPct, netPts };
  if (netPct <= -0.001) return { dir: 'DOWN', netPct, netPts };
  return { dir: null, netPct, netPts };
}

export function blockEntryAtExtreme(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  bar: TenSecBar
): { ok: boolean; reason: string } {
  const five = aggregateTenSecToFiveMin(withLive(bars, bar));
  const atr = atrWilder(five.length ? five : withLive(bars, bar), 14);
  return blockLateChaseAdaptive(direction, five.length ? five : withLive(bars, bar), atr);
}

const BARS_1M = 6;
const BARS_5M = 30;

export function netPtsLookback(
  bars: TenSecBar[] | null | undefined,
  liveBar: TenSecBar | null | undefined,
  lookback: number
): number {
  const all = withLive(bars, liveBar);
  if (all.length < 2) return 0;
  const window = all.slice(-Math.max(lookback, 2));
  return window[window.length - 1]!.close - window[0]!.open;
}

export type MultiTfTape = {
  pts1m: number;
  pts5m: number;
};

export function multiTfPts(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): MultiTfTape {
  return {
    pts1m: netPtsLookback(bars, liveBar, BARS_1M),
    pts5m: netPtsLookback(bars, liveBar, BARS_5M),
  };
}

function formatTf(t: MultiTfTape): string {
  return `1m=${t.pts1m.toFixed(1)} 5m=${t.pts5m.toFixed(1)}`;
}

export function longTapeUp(t: MultiTfTape, price = 1): boolean {
  const abs = Math.max(Math.abs(price), Math.abs(t.pts5m) || 1, 1e-9);
  const thr5 = Math.max(abs * 0.00015, abs * 1e-6);
  const thr1 = Math.max(abs * 0.00005, abs * 1e-7);
  return t.pts5m > thr5 && t.pts1m > thr1;
}

export function shortTapeDown(t: MultiTfTape, price = 1): boolean {
  const abs = Math.max(Math.abs(price), Math.abs(t.pts5m) || 1, 1e-9);
  const thr5 = Math.max(abs * 0.00015, abs * 1e-6);
  const thr1 = Math.max(abs * 0.00005, abs * 1e-7);
  return t.pts5m < -thr5 && t.pts1m < -thr1;
}

export function shortTapeUp(t: MultiTfTape, price = 1): boolean {
  return longTapeUp(t, price);
}

export function softBiasUp(t: MultiTfTape): boolean {
  return t.pts5m > 0 && t.pts1m >= 0;
}
export function softBiasDown(t: MultiTfTape): boolean {
  return t.pts5m < 0 && t.pts1m <= 0;
}

export function earlyTriggerUp(_t: MultiTfTape, pts90s: number): boolean {
  return _t.pts1m > 0 || pts90s > 0;
}
export function earlyTriggerDown(_t: MultiTfTape, pts90s: number): boolean {
  return _t.pts1m < 0 || pts90s < 0;
}

/** Anti-fade — block entry against clear impulse (no PROFIT bypass). */
export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const t = multiTfPts(bars, liveBar);
  const price = liveBar?.close ?? bars?.[bars.length - 1]?.close ?? 1;
  if (direction === 'BUY' && shortTapeDown(t, price)) {
    return { ok: false, reason: `BLOCK BUY · impulse DOWN · ${formatTf(t)}` };
  }
  if (direction === 'SELL' && longTapeUp(t, price)) {
    return { ok: false, reason: `BLOCK SELL · impulse UP · ${formatTf(t)}` };
  }
  return { ok: true, reason: `${direction} vs impulse ok` };
}

/** Adaptive late-chase / climax block (no PROFIT bypass). */
export function blockLateTrendChase(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  return blockEntryAtExtreme(direction, bars, liveBar ?? bars?.[bars.length - 1]!);
}

export function zoneFadeAllowed(
  direction: 'BUY' | 'SELL',
  setup: string | null | undefined,
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const s = String(setup || '').toUpperCase();
  if (s !== 'REJECT' && s !== 'BOUNCE') return { ok: true, reason: 'not a fade setup' };
  const pts5m = netPtsLookback(bars, liveBar, BARS_5M);
  const pts1m = netPtsLookback(bars, liveBar, BARS_1M);
  if (direction === 'SELL' && s === 'REJECT') {
    if (pts5m > 0 || pts1m > 0) {
      return {
        ok: false,
        reason: `BLOCK SELL REJECT · tape still UP/flat 5m=${pts5m.toFixed(1)} 1m=${pts1m.toFixed(1)} (map≠fade)`,
      };
    }
  }
  if (direction === 'BUY' && s === 'BOUNCE') {
    if (pts5m < 0 && pts1m < 0) {
      return {
        ok: false,
        reason: `BLOCK BUY BOUNCE · tape DOWN 5m=${pts5m.toFixed(1)} 1m=${pts1m.toFixed(1)} (map≠fade)`,
      };
    }
  }
  return { ok: true, reason: 'fade aligns with tape' };
}

export function lateChaseAppliesToSetup(
  setup: RegimeEntry['setup'],
  _regime?: string | null
): boolean {
  return (
    setup === 'BREAKOUT' ||
    setup === 'CONTINUATION' ||
    setup === 'PULLBACK' ||
    setup === 'SWEEP_RECLAIM'
  );
}

function regimeBias(r: RegimeName): 'BUY' | 'SELL' | null {
  if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP') return 'BUY';
  if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN') return 'SELL';
  return null;
}

export function marketDirection(
  regime?: string | null,
  closedBars?: TenSecBar[] | null,
  liveBar?: TenSecBar | null
): 'BUY' | 'SELL' | null {
  const short = shortNetMove(closedBars, liveBar);
  if (short.dir === 'UP') return 'BUY';
  if (short.dir === 'DOWN') return 'SELL';
  return regimeBias(normalizeRegime(regime));
}

export function explainNoEntry(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): string {
  const decision = decideEntryFrom10sRegime(bar, regime, closedBars);
  if (decision) return `SETUP ${decision.direction} · ${decision.reason}`;
  const t = multiTfPts(closedBars, bar);
  return `SCAN · waiting 5m structure · ${formatTf(t)}`;
}

export function continuationSameSide(
  openSide: 'BUY' | 'SELL',
  bar: TenSecBar | null | undefined,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): { ok: boolean; reason: string } {
  const tape = tapeSide(closedBars, bar ?? null);
  if (tape.dir === openSide) {
    return { ok: true, reason: `continuation · ${tape.reason}` };
  }
  if (!bar) {
    const dir = marketDirection(regime, closedBars, null);
    if (dir === openSide) {
      return { ok: true, reason: `continuation · market still ${dir}` };
    }
    return { ok: false, reason: 'no continuation · direction unclear/flipped' };
  }
  const dir = marketDirection(regime, closedBars, bar);
  if (dir === openSide) {
    return { ok: true, reason: `continuation · market ${dir}` };
  }
  if (openSide === 'BUY' && isGreen(bar) && !shortTapeDown(multiTfPts(closedBars, bar), bar.close)) {
    return { ok: true, reason: 'continuation · live green' };
  }
  if (openSide === 'SELL' && isRed(bar) && !longTapeUp(multiTfPts(closedBars, bar), bar.close)) {
    return { ok: true, reason: 'continuation · live red' };
  }
  return { ok: false, reason: `no continuation · ${tape.reason}` };
}

export function tapeSide(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): {
  dir: 'BUY' | 'SELL' | null;
  pts90s: number;
  pts1m: number;
  pts5m: number;
  reason: string;
} {
  const t = multiTfPts(bars, liveBar);
  const pts90s = netPtsLookback(bars, liveBar, 9);
  const price = liveBar?.close ?? bars?.[bars.length - 1]?.close ?? 1;
  const line = formatTf(t);

  if (longTapeUp(t, price) || shortTapeUp(t, price)) {
    return {
      dir: 'BUY',
      pts90s,
      pts1m: t.pts1m,
      pts5m: t.pts5m,
      reason: `TAPE UP · ${line}`,
    };
  }

  if (shortTapeDown(t, price)) {
    return {
      dir: 'SELL',
      pts90s,
      pts1m: t.pts1m,
      pts5m: t.pts5m,
      reason: `TAPE DOWN · ${line}`,
    };
  }

  return {
    dir: null,
    pts90s,
    pts1m: t.pts1m,
    pts5m: t.pts5m,
    reason: `TAPE FLAT · ${line}`,
  };
}

function mapSetup(s: BrainSetup | null): RegimeEntry['setup'] {
  if (!s) return 'CONTINUATION';
  if (s === 'SWEEP_RECLAIM') return 'SWEEP_RECLAIM';
  if (s === 'FAILED_BREAKOUT') return 'FAILED_BREAKOUT';
  if (s === 'REVERSAL') return 'REVERSAL';
  if (s === 'BREAKOUT') return 'BREAKOUT';
  if (s === 'PULLBACK') return 'PULLBACK';
  return 'CONTINUATION';
}

/**
 * Canonical entry: 5m structure + LTF confirm.
 * Prefer Capital-native 5m/1m books; 10s only as trigger/microstructure.
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null,
  opts?: {
    spread?: number | null;
    feed_agreement?: number | null;
    broker_min_stop?: number | null;
    htf?: { trend?: 'UP' | 'DOWN' | 'RANGE' | null; near_support?: boolean; near_resistance?: boolean; detail?: string } | null;
    bars5m?: StructureBar[] | null;
    bars1m?: StructureBar[] | null;
    bars15m?: StructureBar[] | null;
    multiTfReady?: boolean;
    analysis_price?: number | null;
    tick_size?: number | null;
    /** Stateful early ARMED→TRIGGERED machine (persisted by desk). */
    armed_state?: ArmedTriggerState | null;
    on_armed_state?: (s: ArmedTriggerState) => void;
    now_ms?: number;
  }
): RegimeEntry | null {
  // multiTfReady must be explicitly true (#12)
  if (opts?.multiTfReady !== true) {
    return null;
  }
  // Hard reject: synthetic bar as microstructure trigger
  if (bar.provenance === 'SYNTHETIC') {
    return null;
  }
  // Missing provenance is not REAL (#14)
  if (bar.provenance !== 'REAL') {
    return null;
  }

  const series = withLive(closedBars, bar);
  const microGate = allowMicrostructureFromBars(series.slice(-30));
  const bars5m =
    opts?.bars5m && opts.bars5m.length >= 8
      ? opts.bars5m.filter((b) => b.provenance === 'REAL')
      : aggregateTenSecToFiveMin(series);
  const bars1m =
    opts?.bars1m && opts.bars1m.length >= 4
      ? opts.bars1m.filter((b) => b.provenance === 'REAL')
      : aggregateTenSecToOneMin(series);

  if (!bars5m.length) {
    void decideFromLtfAlone(series);
    return null;
  }

  // Analysis MID required — never fallback to bar.close (#13)
  if (opts?.analysis_price == null || !Number.isFinite(opts.analysis_price)) {
    return null;
  }
  const price = opts.analysis_price;

  const decision = decideFiveMinuteEntry({
    bars5m,
    bars1m,
    bars10s: microGate.ok ? series.slice(-30) : [],
    htf: opts?.htf ?? null,
    regime,
    price,
    spread: opts?.spread,
    feed_agreement: opts?.feed_agreement,
    broker_min_stop: opts?.broker_min_stop,
    tick_size: opts?.tick_size,
  });

  const zone = buildScalpZone(closedBars);

  // Strong/late path: full 5m BOS/CHoCH (+ LTF) still enters when ready.
  if (decision.entry && decision.direction) {
    const impulse = allowEntryAgainstImpulse(decision.direction, closedBars, bar);
    if (!impulse.ok) return null;
    const late = blockLateTrendChase(decision.direction, closedBars, bar);
    if (!late.ok) return null;
    opts?.on_armed_state?.(idleArmedState());
    return {
      direction: decision.direction,
      setup: mapSetup(decision.setup),
      reason: `${decision.reason} · ${describe(bar)}`,
      zone,
      zone_setup: null,
      structural_sl: decision.structural_sl,
      evidence_score: decision.evidence_score,
    };
  }

  // Early path: SETUP→ARMED→TRIGGERED without waiting for full 5m BOS/CHoCH.
  const early = advanceEarlyEntryArmed(opts?.armed_state ?? idleArmedState(), {
    now_ms: opts?.now_ms ?? Date.now(),
    price,
    bars5m,
    bars1m,
    bars10s: microGate.ok ? series.slice(-40) : series.slice(-40),
    htf: opts?.htf ?? null,
    spread: opts?.spread,
    tick_size: opts?.tick_size,
    broker_min_stop: opts?.broker_min_stop,
  });
  opts?.on_armed_state?.(early.state);
  if (!early.signal) return null;

  const impulse = allowEntryAgainstImpulse(early.signal.direction, closedBars, bar);
  if (!impulse.ok) {
    // Do not leave phase=TRIGGERED — that would reset SETUP next tick and drop the fire forever.
    opts?.on_armed_state?.({
      ...early.state,
      phase: 'ARMED',
      detail: `ARMED · post-trigger blocked · impulse · ${impulse.reason}`,
    });
    return null;
  }
  const late = blockLateTrendChase(early.signal.direction, closedBars, bar);
  if (!late.ok) {
    opts?.on_armed_state?.({
      ...early.state,
      phase: 'ARMED',
      detail: `ARMED · post-trigger blocked · late-chase · ${late.reason}`,
    });
    return null;
  }

  return {
    direction: early.signal.direction,
    setup: early.signal.setup,
    reason: `${early.signal.reason} · ${describe(bar)}`,
    zone,
    zone_setup: null,
    structural_sl: early.signal.structural_sl,
    evidence_score: 0.7,
  };
}

export { buildScalpZone, formatZoneInfo, type ScalpZone };
export { decideFiveMinuteEntry, aggregateTenSecToFiveMin, aggregateTenSecToOneMin };
