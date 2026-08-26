/**
 * 10s multi-TF tape entry — no regime WAIT, no zone-setup wait.
 * Only 5m + 1m (10m/25m removed from direction — user: too noisy/narrow).
 * 5m+1m UP → BUY · 5m+1m DOWN → SELL.
 * Zone (~25 min) = MAP only. Regime labels never block entry.
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

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
  zone?: ScalpZone | null;
  zone_setup?: ZoneSetup | null;
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

/** Late chase on 10s — ~0.12% ≈ 5.5pt Gold (was 0.28% ≈13pt — entered too late). */
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
  // ~0.08% ≈ 3.7pt over lookback
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

/** Short ~60–90s net including live bar. */
export function shortNetMove(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  return recentImpulse(withLive(bars, liveBar), 9);
}

/**
 * ~5–10 min tape helper (legacy name). Entry direction uses 5m+1m via multiTfPts.
 */
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

/** ~4 min struct net — catches overnight drift on 10s stack. */
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
  // ~0.10% ≈ 4.6pt Gold over ~4 min — enough struct, not overnight silence
  if (netPct >= 0.001) return { dir: 'UP', netPct, netPts };
  if (netPct <= -0.001) return { dir: 'DOWN', netPct, netPts };
  return { dir: null, netPct, netPts };
}

/**
 * Block chasing into swing extremes after a big struct move.
 * Prevents SELL at dump bottom / BUY at rally top (02:00 SELL @4633 case).
 */
export function blockEntryAtExtreme(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  bar: TenSecBar
): { ok: boolean; reason: string } {
  const all = bars ?? [];
  if (all.length < 8) return { ok: true, reason: 'no struct extreme gate' };

  // Prefer ~5 min window for "already at climax" (no 10m)
  const recent = all.slice(-Math.min(30, all.length));
  const high = Math.max(...recent.map((b) => b.high));
  const low = Math.min(...recent.map((b) => b.low));
  const range = Math.max(high - low, 0.01);
  const price = bar.close;
  const net = recent[recent.length - 1]!.close - recent[0]!.open;

  if (direction === 'SELL' && net <= -3 && price <= low + range * 0.25) {
    return {
      ok: false,
      reason: `BLOCK SELL · dump ${net.toFixed(1)}pt · at swing low (no chase bottom)`,
    };
  }
  if (direction === 'BUY' && net >= 3 && price >= high - range * 0.25) {
    return {
      ok: false,
      reason: `BLOCK BUY · rally ${net.toFixed(1)}pt · at swing high (no chase top)`,
    };
  }
  return { ok: true, reason: 'struct extreme ok' };
}

/** 10s bars → TF windows (entry uses 5m + 1m only) */
const BARS_1M = 6;
const BARS_5M = 30;

/**
 * Hard anti-fade (10s brain).
 * Zone (~150×10s) = MAP only. Absolute point nets — not soft % dir that pullbacks wipe.
 */
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

/** Clear UP stack — 5m+1m (no 10m/25m). */
export function longTapeUp(t: MultiTfTape): boolean {
  return t.pts5m > 0.8 && t.pts1m > 0.3;
}

/** Clear DOWN tape — 5m dump or 5m+1m dump. */
export function shortTapeDown(t: MultiTfTape): boolean {
  if (t.pts5m < -1.2) return true;
  if (t.pts5m < -0.8 && t.pts1m < -0.35) return true;
  return false;
}

/** Clear UP tape — 5m rally or 5m+1m. */
export function shortTapeUp(t: MultiTfTape): boolean {
  if (t.pts5m > 1.2) return true;
  if (t.pts5m > 0.8 && t.pts1m > 0.35) return true;
  return false;
}

export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const t = multiTfPts(bars, liveBar);

  // Only hard veto: never fade the clear opposite multi-TF stack
  if (direction === 'SELL' && longTapeUp(t)) {
    return {
      ok: false,
      reason: `BLOCK SELL · multi-TF UP ${formatTf(t)} (only BUY)`,
    };
  }
  if (direction === 'BUY' && shortTapeDown(t) && t.pts5m < -1.2) {
    return {
      ok: false,
      reason: `BLOCK BUY · multi-TF DOWN ${formatTf(t)} (only SELL)`,
    };
  }
  return { ok: true, reason: 'tape aligns with entry' };
}

/** Disabled — user: no WAIT / late-chase blocks. Kept export for callers. */
export function blockLateTrendChase(
  _direction: 'BUY' | 'SELL',
  _bars: TenSecBar[] | null | undefined,
  _liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  return { ok: true, reason: 'late-chase gate off' };
}

/** REJECT/BOUNCE fade only WITH tape — not against it. */
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
    // Must have actual down tape — SUPPLY alone is not enough
    if (pts5m > 0 || pts1m > 0) {
      return {
        ok: false,
        reason: `BLOCK SELL REJECT · tape still UP/flat 5m=${pts5m.toFixed(1)} 1m=${pts1m.toFixed(1)} (map≠fade)`,
      };
    }
  }
  if (direction === 'BUY' && s === 'BOUNCE') {
    if (pts5m < -1.2 || (pts5m < -0.8 && pts1m < -0.35)) {
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
  // Always apply late-chase gate — TREND regimes used to skip it → BUY at climax
  return setup === 'BREAKOUT' || setup === 'CONTINUATION' || setup === 'PULLBACK';
}

function regimeBias(r: RegimeName): 'BUY' | 'SELL' | null {
  if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP') return 'BUY';
  if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN') return 'SELL';
  // EXPANSION alone is NOT a direction — need slope
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
  _regime?: string | null,
  closedBars?: TenSecBar[] | null
): string {
  const tape = tapeSide(closedBars, bar);
  if (!tape.dir) {
    return `SCAN · ${tape.reason} · need clear UP→BUY or DOWN→SELL`;
  }
  const vs = allowEntryAgainstImpulse(tape.dir, closedBars, bar);
  if (!vs.ok) return `SCAN · ${vs.reason}`;
  return `SCAN · ${tape.reason}`;
}

/**
 * Continuation check for BO — same side still valid (zone optional soft).
 * Used before PeakProtect/TP close: if true → HOLD.
 */
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
  if (openSide === 'BUY' && isGreen(bar) && !shortTapeDown(multiTfPts(closedBars, bar))) {
    return { ok: true, reason: 'continuation · live green' };
  }
  if (openSide === 'SELL' && isRed(bar) && !longTapeUp(multiTfPts(closedBars, bar))) {
    return { ok: true, reason: 'continuation · live red' };
  }
  return { ok: false, reason: `no continuation · ${tape.reason}` };
}

/**
 * Multi-TF tape — 5m + 1m only. No regime / late / bar WAIT.
 * UP → BUY, DOWN → SELL.
 */
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
  const line = formatTf(t);

  // Clear UP (5m+1m) → BUY
  if (longTapeUp(t) || shortTapeUp(t)) {
    return {
      dir: 'BUY',
      pts90s,
      pts1m: t.pts1m,
      pts5m: t.pts5m,
      reason: `TAPE UP · ${line}`,
    };
  }

  // Clear DOWN (5m or 5m+1m) → SELL
  if (shortTapeDown(t)) {
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

export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  _regime?: string | null,
  closedBars?: TenSecBar[] | null
): RegimeEntry | null {
  // No regime / late-bar / climax WAIT — tape only.
  const tape = tapeSide(closedBars, bar);
  if (!tape.dir) return null;

  const vsTape = allowEntryAgainstImpulse(tape.dir, closedBars, bar);
  if (!vsTape.ok) return null;

  const zone = buildScalpZone(closedBars);

  return {
    direction: tape.dir,
    setup: 'CONTINUATION',
    reason: `${tape.reason} · ${describe(bar)}`,
    zone,
    zone_setup: null,
  };
}

export { buildScalpZone, formatZoneInfo, type ScalpZone };
