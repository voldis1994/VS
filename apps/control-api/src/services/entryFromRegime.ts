/**
 * 10s tape-follow entry.
 * Rule: tape UP → BUY, tape DOWN → SELL. Zone = MAP only (not a setup wait).
 * Still block: fade against tape, late climax chase, signal bar already ran.
 */
import type { RegimeName } from './regimes.js';
import { describeRegimeContext, normalizeRegime } from './regimes.js';
import { bodyPct, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import {
  buildScalpZone,
  evaluateZoneEntry,
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
 * ~10 min tape (60×10s) — scalp direction. Zone map (~25 min) is WHERE, not fade signal.
 */
export function tenMinTape(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  return recentImpulse(withLive(bars, liveBar), 60);
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

  // Prefer ~10 min window for "already at climax"
  const recent = all.slice(-Math.min(60, all.length));
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

const HARD_BLOCK_REGIMES: RegimeName[] = [
  'TRANSITION',
  'REVERSAL_CANDIDATE',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
];

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

export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const pts90s = netPtsLookback(bars, liveBar, 9);
  const pts3m = netPtsLookback(bars, liveBar, 18);
  const pts5m = netPtsLookback(bars, liveBar, 30);
  const pts10m = netPtsLookback(bars, liveBar, 60);

  // Absolute veto — pullback at top must NOT allow SELL into 10m UP
  if (direction === 'SELL') {
    if (pts10m > 2) {
      return { ok: false, reason: `BLOCK SELL · 10m UP ${pts10m.toFixed(1)}pt (zone≠fade)` };
    }
    if (pts5m > 1.5) {
      return { ok: false, reason: `BLOCK SELL · 5m UP ${pts5m.toFixed(1)}pt (zone≠fade)` };
    }
    if (pts3m > 1.2) {
      return { ok: false, reason: `BLOCK SELL · 3m UP ${pts3m.toFixed(1)}pt (zone≠fade)` };
    }
    if (pts90s > 0.8) {
      return { ok: false, reason: `BLOCK SELL · 90s UP ${pts90s.toFixed(1)}pt (zone≠fade)` };
    }
  }
  if (direction === 'BUY') {
    if (pts10m < -2) {
      return { ok: false, reason: `BLOCK BUY · 10m DOWN ${pts10m.toFixed(1)}pt (zone≠fade)` };
    }
    if (pts5m < -1.5) {
      return { ok: false, reason: `BLOCK BUY · 5m DOWN ${pts5m.toFixed(1)}pt (zone≠fade)` };
    }
    if (pts3m < -1.2) {
      return { ok: false, reason: `BLOCK BUY · 3m DOWN ${pts3m.toFixed(1)}pt (zone≠fade)` };
    }
    if (pts90s < -0.8) {
      return { ok: false, reason: `BLOCK BUY · 90s DOWN ${pts90s.toFixed(1)}pt (zone≠fade)` };
    }
  }
  return { ok: true, reason: 'tape aligns with entry' };
}

/**
 * Block BUY/SELL after the move already happened (WAIT all trend → chase climax).
 * 10s brain: enter WITH early trend / pullback — not at the end.
 */
export function blockLateTrendChase(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const all = withLive(bars, liveBar);
  if (all.length < 8) return { ok: true, reason: 'not enough bars' };
  const pts5m = netPtsLookback(bars, liveBar, 30);
  const pts10m = netPtsLookback(bars, liveBar, 60);
  const window = all.slice(-Math.min(60, all.length));
  const hi = Math.max(...window.map((b) => b.high));
  const lo = Math.min(...window.map((b) => b.low));
  const span = Math.max(hi - lo, 0.01);
  const price = (liveBar ?? window[window.length - 1]!).close;
  const pos = (price - lo) / span; // 0=swing low, 1=swing high

  if (direction === 'BUY') {
    if (pts10m > 6 || pts5m > 4) {
      return {
        ok: false,
        reason: `BLOCK BUY · too late · trend already ran 10m=+${pts10m.toFixed(1)} 5m=+${pts5m.toFixed(1)}`,
      };
    }
    if (pts10m > 3 && pos >= 0.72) {
      return {
        ok: false,
        reason: `BLOCK BUY · chase top · 10m=+${pts10m.toFixed(1)}pt · @${(pos * 100).toFixed(0)}% of range`,
      };
    }
  }
  if (direction === 'SELL') {
    if (pts10m < -6 || pts5m < -4) {
      return {
        ok: false,
        reason: `BLOCK SELL · too late · dump already ran 10m=${pts10m.toFixed(1)} 5m=${pts5m.toFixed(1)}`,
      };
    }
    if (pts10m < -3 && pos <= 0.28) {
      return {
        ok: false,
        reason: `BLOCK SELL · chase bottom · 10m=${pts10m.toFixed(1)}pt · @${(pos * 100).toFixed(0)}% of range`,
      };
    }
  }
  return { ok: true, reason: 'not a late chase' };
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
  const pts10m = netPtsLookback(bars, liveBar, 60);
  const pts5m = netPtsLookback(bars, liveBar, 30);
  if (direction === 'SELL' && s === 'REJECT') {
    // Must have actual down tape — SUPPLY alone is not enough
    if (pts10m > 0 || pts5m > 0) {
      return {
        ok: false,
        reason: `BLOCK SELL REJECT · tape still UP/flat 10m=${pts10m.toFixed(1)} 5m=${pts5m.toFixed(1)} (map≠fade)`,
      };
    }
  }
  if (direction === 'BUY' && s === 'BOUNCE') {
    if (pts10m < -1.5 || pts5m < -1.5) {
      return {
        ok: false,
        reason: `BLOCK BUY BOUNCE · tape DOWN 10m=${pts10m.toFixed(1)} 5m=${pts5m.toFixed(1)} (map≠fade)`,
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
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): string {
  const r = normalizeRegime(regime);
  const zone = buildScalpZone(closedBars);
  const regimeLine = describeRegimeContext(closedBars, r);
  const zoneLine = formatZoneInfo(zone, closedBars);
  const barLine = `signal bar body=${(bodyPct(bar) * 100).toFixed(2)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
  const tape = tapeSide(closedBars, bar);

  if (HARD_BLOCK_REGIMES.includes(r)) {
    return `WAIT · ${regimeLine} · ${zoneLine} · ${barLine}`;
  }
  if (signalBarTooLate(bar)) {
    return `WAIT · too late (bar already ran) · ${tape.reason} · ${barLine}`;
  }
  if (!tape.dir) {
    return `WAIT · ${tape.reason} · need UP→BUY or DOWN→SELL · ${zoneLine}`;
  }
  const vs = allowEntryAgainstImpulse(tape.dir, closedBars, bar);
  if (!vs.ok) return `WAIT · ${vs.reason} · ${tape.reason}`;
  const late = blockLateTrendChase(tape.dir, closedBars, bar);
  if (!late.ok) return `WAIT · ${late.reason} · ${tape.reason}`;
  const extreme = blockEntryAtExtreme(tape.dir, closedBars, bar);
  if (!extreme.ok) return `WAIT · ${extreme.reason} · ${tape.reason}`;
  return `WAIT · filters · ${tape.reason} · ${regimeLine} · ${barLine}`;
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
  if (!bar) {
    const dir = marketDirection(regime, closedBars, null);
    if (dir === openSide) {
      return { ok: true, reason: `continuation · market still ${dir}` };
    }
    return { ok: false, reason: 'no continuation · direction unclear/flipped' };
  }
  const dir = marketDirection(regime, closedBars, bar);
  if (dir !== openSide) {
    return { ok: false, reason: `no continuation · market ${dir ?? 'flat'} vs open ${openSide}` };
  }
  const vs = allowEntryAgainstImpulse(openSide, closedBars, bar);
  if (!vs.ok) return { ok: false, reason: `no continuation · ${vs.reason}` };
  // Zone still supportive or breakout continuation
  const zone = buildScalpZone(closedBars);
  if (zone) {
    const zv = evaluateZoneEntry(openSide, bar, zone, closedBars);
    if (zv.ok) return { ok: true, reason: `continuation · ${zv.reason}` };
  }
  // Trend regimes: direction alone is enough to hold
  const r = normalizeRegime(regime);
  if (
    (openSide === 'BUY' && (r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP')) ||
    (openSide === 'SELL' && (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN'))
  ) {
    return { ok: true, reason: `continuation · ${r} still with ${openSide}` };
  }
  if (openSide === 'BUY' && isGreen(bar)) {
    return { ok: true, reason: 'continuation · live green with market UP' };
  }
  if (openSide === 'SELL' && isRed(bar)) {
    return { ok: true, reason: 'continuation · live red with market DOWN' };
  }
  return { ok: false, reason: 'no clear continuation signal' };
}

/**
 * Simple tape side: UP → BUY, DOWN → SELL.
 * No "wait for perfect zone setup" — zone is map only.
 */
export function tapeSide(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'BUY' | 'SELL' | null; pts90s: number; pts5m: number; pts10m: number; reason: string } {
  const pts90s = netPtsLookback(bars, liveBar, 9);
  const pts3m = netPtsLookback(bars, liveBar, 18);
  const pts5m = netPtsLookback(bars, liveBar, 30);
  const pts10m = netPtsLookback(bars, liveBar, 60);

  let up = 0;
  let down = 0;
  if (pts90s > 0.8) up += 2;
  if (pts90s < -0.8) down += 2;
  if (pts3m > 1.2) up += 2;
  if (pts3m < -1.2) down += 2;
  if (pts5m > 1.5) up += 3;
  if (pts5m < -1.5) down += 3;
  if (pts10m > 2) up += 3;
  if (pts10m < -2) down += 3;

  if (up > down && up >= 2) {
    return {
      dir: 'BUY',
      pts90s,
      pts5m,
      pts10m,
      reason: `TAPE UP · 90s=${pts90s.toFixed(1)} 5m=${pts5m.toFixed(1)} 10m=${pts10m.toFixed(1)}`,
    };
  }
  if (down > up && down >= 2) {
    return {
      dir: 'SELL',
      pts90s,
      pts5m,
      pts10m,
      reason: `TAPE DOWN · 90s=${pts90s.toFixed(1)} 5m=${pts5m.toFixed(1)} 10m=${pts10m.toFixed(1)}`,
    };
  }
  return {
    dir: null,
    pts90s,
    pts5m,
    pts10m,
    reason: `TAPE FLAT · 90s=${pts90s.toFixed(1)} 5m=${pts5m.toFixed(1)} 10m=${pts10m.toFixed(1)}`,
  };
}

export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (HARD_BLOCK_REGIMES.includes(r)) return null;
  if (signalBarTooLate(bar)) return null;

  // ——— Simple rule: tape UP = BUY, tape DOWN = SELL ———
  const tape = tapeSide(closedBars, bar);
  if (!tape.dir) return null;

  const vsTape = allowEntryAgainstImpulse(tape.dir, closedBars, bar);
  if (!vsTape.ok) return null;

  const late = blockLateTrendChase(tape.dir, closedBars, bar);
  if (!late.ok) return null;

  const extreme = blockEntryAtExtreme(tape.dir, closedBars, bar);
  if (!extreme.ok) return null;

  const zone = buildScalpZone(closedBars);

  return {
    direction: tape.dir,
    setup: 'CONTINUATION',
    reason: `${tape.reason} · ${r} · ${candle}`,
    zone,
    zone_setup: null,
  };
}

export { buildScalpZone, formatZoneInfo, type ScalpZone };
