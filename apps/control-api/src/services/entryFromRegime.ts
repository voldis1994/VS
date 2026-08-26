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
  'TRANSITION',
  'REVERSAL_CANDIDATE',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
];

/** Flat labels — still trade when short/struct trend is clear (was hard-blocked → overnight WAIT). */
const CHOP_REGIMES: RegimeName[] = ['COMPRESSION', 'RANGE', 'UNKNOWN'];

/**
 * Never fade the 10s / ~10 min tape.
 * Zone (~150×10s) is a MAP for levels — not a reason to SELL into UP or BUY into DOWN.
 */
export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const short = shortNetMove(bars, liveBar);
  const midImp = recentImpulse(withLive(bars, liveBar), 18); // ~3 min
  const tape10 = tenMinTape(bars, liveBar);
  const struct = structNetMove(bars, 24);

  const up =
    short.dir === 'UP' ||
    midImp.dir === 'UP' ||
    tape10.dir === 'UP' ||
    struct.dir === 'UP';
  const down =
    short.dir === 'DOWN' ||
    midImp.dir === 'DOWN' ||
    tape10.dir === 'DOWN' ||
    struct.dir === 'DOWN';

  if (direction === 'SELL' && up) {
    const pts = tape10.dir === 'UP' ? tape10.netPts : midImp.dir === 'UP' ? midImp.netPts : short.netPts;
    return {
      ok: false,
      reason: `BLOCK SELL · tape UP ${pts.toFixed(1)}pt (10s brain — zone map ≠ fade)`,
    };
  }
  if (direction === 'BUY' && down) {
    const pts = tape10.dir === 'DOWN' ? tape10.netPts : midImp.dir === 'DOWN' ? midImp.netPts : short.netPts;
    return {
      ok: false,
      reason: `BLOCK BUY · tape DOWN ${pts.toFixed(1)}pt (10s brain — zone map ≠ fade)`,
    };
  }
  // Mild short thresholds (backup)
  if (direction === 'BUY' && short.netPct <= -0.0005) {
    return {
      ok: false,
      reason: `BLOCK BUY · short dump ${short.netPts.toFixed(1)}pt`,
    };
  }
  if (direction === 'SELL' && short.netPct >= 0.0005) {
    return {
      ok: false,
      reason: `BLOCK SELL · short rally ${short.netPts.toFixed(1)}pt`,
    };
  }
  return { ok: true, reason: 'tape aligns with entry' };
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
  const short = shortNetMove(closedBars, bar);
  const struct = structNetMove(closedBars, 24);
  const regimeLine = describeRegimeContext(closedBars, r);
  const zoneLine = formatZoneInfo(zone, closedBars);
  const barLine = `signal bar body=${(bodyPct(bar) * 100).toFixed(2)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;

  if (HARD_BLOCK_REGIMES.includes(r)) {
    return `WAIT · ${regimeLine} · ${zoneLine} · ${barLine}`;
  }
  if (!zone) {
    return `WAIT · zone required · ${zoneLine} · ${regimeLine} · ${barLine}`;
  }
  if (signalBarTooLate(bar)) {
    return `WAIT · too late (bar already ran) · ${zoneLine} · ${regimeLine} · ${barLine}`;
  }

  const buyZ = evaluateZoneEntry('BUY', bar, zone, closedBars);
  const sellZ = evaluateZoneEntry('SELL', bar, zone, closedBars);
  if (buyZ.ok || sellZ.ok) {
    const dir = buyZ.ok ? 'BUY' : 'SELL';
    const vs = allowEntryAgainstImpulse(dir, closedBars, bar);
    if (!vs.ok) {
      return `WAIT · ${vs.reason} · ${zoneLine} · ${regimeLine}`;
    }
    return `WAIT · zone edge ready but filters · ${buyZ.ok ? buyZ.reason : sellZ.reason} · ${regimeLine}`;
  }

  // Mid-box: honest "scalp edges only"
  return `WAIT · scalp edges only · price mid-zone · ${zoneLine} · ${regimeLine} · short ${short.netPts.toFixed(1)}pt · tape10 ${tenMinTape(closedBars, bar).netPts.toFixed(1)}pt · ${barLine}`;
}

/**
 * Pick real zone setup — BOUNCE/REJECT/RETEST/BREAKOUT at edges.
 * Does NOT invent mid-box trades from flat short slope.
 */
function pickZoneSetup(
  bar: TenSecBar,
  zone: ScalpZone,
  closedBars: TenSecBar[] | null | undefined,
  prefer: 'BUY' | 'SELL' | null
): { dir: 'BUY' | 'SELL'; zv: ReturnType<typeof evaluateZoneEntry> } | null {
  const order: Array<'BUY' | 'SELL'> =
    prefer === 'SELL' ? ['SELL', 'BUY'] : prefer === 'BUY' ? ['BUY', 'SELL'] : ['BUY', 'SELL'];
  for (const dir of order) {
    const zv = evaluateZoneEntry(dir, bar, zone, closedBars);
    if (!zv.ok || !zv.setup) continue;
    if (zv.setup === 'BOUNCE' && dir === 'BUY' && isRed(bar) && bodyPct(bar) < -0.001) continue;
    if (zv.setup === 'REJECT' && dir === 'SELL' && isGreen(bar) && bodyPct(bar) > 0.001) continue;
    return { dir, zv };
  }
  return null;
}

const TREND_REGIMES: RegimeName[] = [
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'EXPANSION',
];

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

  const zone = buildScalpZone(closedBars);
  if (!zone) return null;

  if (signalBarTooLate(bar)) return null;

  const short = shortNetMove(closedBars, bar);
  const struct = structNetMove(closedBars, 24);
  const tape10 = tenMinTape(closedBars, bar);
  const prefer =
    short.dir === 'UP' || tape10.dir === 'UP' || struct.dir === 'UP'
      ? 'BUY'
      : short.dir === 'DOWN' || tape10.dir === 'DOWN' || struct.dir === 'DOWN'
        ? 'SELL'
        : marketDirection(regime, closedBars, bar);

  // ——— Real setup: zone edge is MAP location — tape (10s/~10m) decides side ———
  const picked = pickZoneSetup(bar, zone, closedBars, prefer);
  if (picked) {
    const vsTape = allowEntryAgainstImpulse(picked.dir, closedBars, bar);
    if (!vsTape.ok) return null;
    const extreme = blockEntryAtExtreme(picked.dir, closedBars, bar);
    if (!extreme.ok) return null;
    // Soft live: bounce/reject can be small — allow edge touch with ticks
    if (!softLive(bar) && picked.zv.setup !== 'BOUNCE' && picked.zv.setup !== 'REJECT') {
      return null;
    }
    return {
      direction: picked.dir,
      setup: mapZoneSetup(picked.zv.setup, r),
      reason: `${r} · SETUP ${picked.zv.setup} · ${picked.zv.reason} · tape OK · ${candle}`,
      zone,
      zone_setup: picked.zv.setup,
    };
  }

  // ——— Mid-zone: only with clear TREND regime + slope (not RANGE chase) ———
  if (!TREND_REGIMES.includes(r)) return null;
  if (r === 'EXPANSION' && !short.dir) return null;

  let dir = marketDirection(regime, closedBars, bar);
  if (CHOP_REGIMES.includes(r)) return null; // never mid-chase RANGE
  if (!dir) return null;
  if (!softLive(bar)) return null;

  const extreme = blockEntryAtExtreme(dir, closedBars, bar);
  if (!extreme.ok) return null;

  // Already ran hard in short window → too late for mid continuation
  if (short.dir && Math.abs(short.netPct) >= 0.0015) return null;

  const aligned =
    (dir === 'BUY' && (short.dir === 'UP' || struct.dir === 'UP' || r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP')) ||
    (dir === 'SELL' && (short.dir === 'DOWN' || struct.dir === 'DOWN' || r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN'));
  if (!aligned) return null;

  return {
    direction: dir,
    setup: 'CONTINUATION',
    reason: `${r} · CONTINUATION trend mid-zone · short ${short.netPts.toFixed(1)}pt · ${candle}`,
    zone,
    zone_setup: null,
  };
}

export { buildScalpZone, formatZoneInfo, type ScalpZone };
