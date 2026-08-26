/**
 * 10s regime + zone entry.
 * Thesis = market direction / regime; structure = zone; bar = timing.
 * No EXPANSION candle-color follow. No stupid trades without zone.
 */
import type { RegimeName } from './regimes.js';
import { describeRegimeContext, normalizeRegime } from './regimes.js';
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import {
  buildScalpZone,
  diagnoseZoneBuild,
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

/** Soft live on 10s — moving bar, not flat doji. */
function softLive(bar: TenSecBar): boolean {
  const pts = Math.abs(bar.close - bar.open);
  return pts >= 0.4 || rangePct(bar) >= 0.00015 || isMoving10s(bar);
}

function isGreen(bar: TenSecBar): boolean {
  return bar.close > bar.open;
}

function isRed(bar: TenSecBar): boolean {
  return bar.close < bar.open;
}

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Late chase on 10s — ~0.28% ≈ 12pt Gold single bar. */
const LATE_SIGNAL_BODY_PCT = 0.0028;

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
  // ~0.08% ≈ 3.7pt over ~1 min — pick up overnight drift sooner
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
  const struct = structNetMove(bars, 24);
  if (!bars?.length || struct.dir == null) return { ok: true, reason: 'no struct extreme gate' };

  const recent = bars.slice(-24);
  const high = Math.max(...recent.map((b) => b.high));
  const low = Math.min(...recent.map((b) => b.low));
  const range = Math.max(high - low, 0.01);
  const price = bar.close;

  if (
    direction === 'SELL' &&
    struct.netPct <= -0.003 &&
    price <= low + range * 0.2
  ) {
    return {
      ok: false,
      reason: `BLOCK SELL · struct dump ${struct.netPts.toFixed(1)}pt · at swing low (no fade bottom)`,
    };
  }
  if (
    direction === 'BUY' &&
    struct.netPct >= 0.003 &&
    price >= high - range * 0.2
  ) {
    return {
      ok: false,
      reason: `BLOCK BUY · struct rally ${struct.netPts.toFixed(1)}pt · at swing high (no chase top)`,
    };
  }
  return { ok: true, reason: 'struct extreme ok' };
}

const HARD_BLOCK_REGIMES: RegimeName[] = [
  'UNKNOWN',
  'TRANSITION',
  'REVERSAL_CANDIDATE',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
];

/** COMPRESSION/RANGE trade when struct trend is clear (not flat chop). */
const CHOP_REGIMES: RegimeName[] = ['COMPRESSION', 'RANGE'];

export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const short = shortNetMove(bars, liveBar);
  if (direction === 'BUY' && short.netPct <= -0.0009) {
    return {
      ok: false,
      reason: `BLOCK BUY · short dump ${short.netPts.toFixed(1)}pt (${(short.netPct * 100).toFixed(2)}%)`,
    };
  }
  if (direction === 'SELL' && short.netPct >= 0.0009) {
    return {
      ok: false,
      reason: `BLOCK SELL · short rally ${short.netPts.toFixed(1)}pt (${(short.netPct * 100).toFixed(2)}%)`,
    };
  }
  const imp = recentImpulse(bars);
  if (!imp.dir) return { ok: true, reason: 'no strong recent impulse' };
  if (direction === 'SELL' && imp.dir === 'UP') {
    return {
      ok: false,
      reason: `BLOCK SELL · fresh UP ${imp.netPts.toFixed(1)}pt — no fade`,
    };
  }
  if (direction === 'BUY' && imp.dir === 'DOWN') {
    return {
      ok: false,
      reason: `BLOCK BUY · fresh DOWN ${imp.netPts.toFixed(1)}pt — no fade`,
    };
  }
  return { ok: true, reason: `impulse ${imp.dir} aligns` };
}

export function lateChaseAppliesToSetup(
  setup: RegimeEntry['setup'],
  regime?: string | null
): boolean {
  const r = normalizeRegime(regime);
  if (r === 'TREND_UP' || r === 'TREND_DOWN') return false;
  if (r === 'PULLBACK_UPTREND' || r === 'PULLBACK_DOWNTREND') return false;
  return setup === 'BREAKOUT' || setup === 'CONTINUATION';
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

function mapZoneSetup(z: ZoneSetup | null | undefined, r: RegimeName): RegimeEntry['setup'] {
  if (z === 'BREAKOUT') return 'BREAKOUT';
  if (z === 'BOUNCE' || z === 'REJECT' || z === 'RETEST') return 'PULLBACK';
  if (r.includes('BREAKOUT')) return 'BREAKOUT';
  return 'CONTINUATION';
}

export function explainNoEntry(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): string {
  const r = normalizeRegime(regime);
  const zone = buildScalpZone(closedBars);
  const dir = marketDirection(regime, closedBars, bar);
  const regimeLine = describeRegimeContext(closedBars, r);
  const zoneLine = formatZoneInfo(zone, closedBars);
  const barLine = `signal bar body=${(bodyPct(bar) * 100).toFixed(2)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;

  const noEntryRegimes: RegimeName[] = [...HARD_BLOCK_REGIMES];
  if (noEntryRegimes.includes(r)) {
    return `WAIT · ${regimeLine} · ${zoneLine} · ${barLine}`;
  }
  if (CHOP_REGIMES.includes(r)) {
    const struct = structNetMove(closedBars, 24);
    if (!struct.dir) {
      return `WAIT · ${regimeLine} · no struct trend yet · ${zoneLine} · ${barLine}`;
    }
  }
  if (!zone) {
    const d = diagnoseZoneBuild(closedBars);
    return `WAIT · zone required · ${zoneLine} · ${regimeLine} · ${barLine}`;
  }
  if (!softLive(bar)) {
    return `WAIT · bar too flat (need movement) · ${zoneLine} · ${regimeLine} · ${barLine}`;
  }
  if (signalBarTooLate(bar)) {
    return `WAIT · late chase bar · ${zoneLine} · ${regimeLine} · ${barLine}`;
  }
  if (!dir) {
    return `WAIT · no market direction · ${regimeLine} · ${zoneLine} · ${barLine}`;
  }
  const extreme = blockEntryAtExtreme(dir, closedBars, bar);
  if (!extreme.ok) {
    return `WAIT · ${extreme.reason} · ${regimeLine} · ${barLine}`;
  }
  const zv = evaluateZoneEntry(dir, bar, zone, closedBars);
  if (!zv.ok) {
    return `WAIT · ${zv.reason} · ${regimeLine} · ${barLine}`;
  }
  return `WAIT · filters pending · ${dir} · ${zv.setup} · ${zoneLine} · ${regimeLine}`;
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

export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (HARD_BLOCK_REGIMES.includes(r)) return null;

  let dir = marketDirection(regime, closedBars, bar);

  // COMPRESSION/RANGE: allow when ~4 min struct trend is clear
  if (CHOP_REGIMES.includes(r)) {
    const struct = structNetMove(closedBars, 24);
    if (!struct.dir) return null;
    dir = struct.dir === 'UP' ? 'BUY' : 'SELL';
  }

  if (!dir) return null;
  if (r === 'EXPANSION' && !shortNetMove(closedBars, bar).dir) return null;

  const extreme = blockEntryAtExtreme(dir, closedBars, bar);
  if (!extreme.ok) return null;

  if (!softLive(bar)) return null;
  if (signalBarTooLate(bar)) return null;

  const zone = buildScalpZone(closedBars);
  if (!zone) return null;

  const zv = evaluateZoneEntry(dir, bar, zone, closedBars);
  if (!zv.ok || !zv.setup) return null;

  // Mild timing agreement — don't require color for breakout/retest already validated
  if (zv.setup === 'BOUNCE' && dir === 'BUY' && isRed(bar) && bodyPct(bar) < -0.001) {
    return null; // bounce failed
  }
  if (zv.setup === 'REJECT' && dir === 'SELL' && isGreen(bar) && bodyPct(bar) > 0.001) {
    return null;
  }

  const setupLabel = CHOP_REGIMES.includes(r) ? 'CONTINUATION' : mapZoneSetup(zv.setup, r);

  return {
    direction: dir,
    setup: setupLabel,
    reason: `${r} · struct ${structNetMove(closedBars, 24).netPts.toFixed(1)}pt · ${zv.reason} · ${candle}`,
    zone,
    zone_setup: zv.setup,
  };
}

export { buildScalpZone, formatZoneInfo, type ScalpZone };
