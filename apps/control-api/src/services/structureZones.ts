/**
 * Real market zones from Capital minute history.
 * Order: zones → confirm regime → entry (never entry before structure is ready).
 */
import type { CapitalPriceCandle } from './capitalCom.js';
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';

export type ZoneBias = 'ABOVE' | 'BELOW' | 'INSIDE';

export type StructureHint =
  | 'RANGE'
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'FAILED_BREAKOUT_UP'
  | 'FAILED_BREAKOUT_DOWN'
  | 'UNKNOWN';

export type MarketZoneBook = {
  ready: boolean;
  high: number;
  low: number;
  mid: number;
  span: number;
  bias: ZoneBias;
  near_high: boolean;
  near_low: boolean;
  structure: StructureHint;
  bar_count: number;
  updated_at: string;
  detail: string;
};

const MIN_BARS = 12;
/** Minute bars after a stable base that must prove break-then-fail (not 3×10s). */
const FAILED_BREAK_PROBE_BARS = 6;
const FAILED_BREAK_MIN_TOTAL = MIN_BARS + FAILED_BREAK_PROBE_BARS;

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function emptyZones(detail = 'zones not seeded'): MarketZoneBook {
  return {
    ready: false,
    high: 0,
    low: 0,
    mid: 0,
    span: 0,
    bias: 'INSIDE',
    near_high: false,
    near_low: false,
    structure: 'UNKNOWN',
    bar_count: 0,
    updated_at: new Date().toISOString(),
    detail,
  };
}

/**
 * Failed breakout from MULTI-MINUTE structure only.
 * Needs a stable base range (≥12m) then ≥6m probe that broke outside and closed back inside.
 * Not "3×10s wick back inside a micro H/L".
 */
export function detectFailedBreakFromMinutes(
  candles: CapitalPriceCandle[]
): 'FAILED_BREAKOUT_UP' | 'FAILED_BREAKOUT_DOWN' | null {
  if (candles.length < FAILED_BREAK_MIN_TOTAL) return null;

  const base = candles.slice(0, -FAILED_BREAK_PROBE_BARS);
  const probe = candles.slice(-FAILED_BREAK_PROBE_BARS);
  if (base.length < MIN_BARS || probe.length < FAILED_BREAK_PROBE_BARS) return null;

  const hi = Math.max(...base.map((c) => c.high));
  const lo = Math.min(...base.map((c) => c.low));
  const last = probe[probe.length - 1]!;
  const backInside = last.close <= hi && last.close >= lo;
  if (!backInside) return null;

  let brokeAbove = false;
  let brokeBelow = false;
  for (const c of probe.slice(0, -1)) {
    if (c.close > hi) brokeAbove = true;
    if (c.close < lo) brokeBelow = true;
  }

  const lastBody = last.close - last.open;
  // Fail-up: poked above multi-minute H, last minute back inside and red
  if (brokeAbove && !brokeBelow && lastBody < 0) return 'FAILED_BREAKOUT_UP';
  // Fail-down: poked below multi-minute L, last minute back inside and green
  if (brokeBelow && !brokeAbove && lastBody > 0) return 'FAILED_BREAKOUT_DOWN';
  return null;
}

/**
 * Build structure zones from Capital MINUTE candles + current mid.
 * Prior window (all but last) defines the range; last bar tests breakout.
 * Failed breakout requires a multi-minute probe — never 10s micro noise.
 */
export function buildZonesFromMinutes(
  candles: CapitalPriceCandle[],
  lastMid?: number | null
): MarketZoneBook {
  if (!candles.length || candles.length < MIN_BARS) {
    return emptyZones(`need ≥${MIN_BARS} minute bars · have ${candles.length}`);
  }

  const prior = candles.slice(0, -1);
  const last = candles[candles.length - 1]!;
  const failed = detectFailedBreakFromMinutes(candles);
  // On failed break, H/L = stable base (exclude probe) so "inside" is the real zone
  const rangeBars =
    failed && candles.length >= FAILED_BREAK_MIN_TOTAL
      ? candles.slice(0, -FAILED_BREAK_PROBE_BARS)
      : prior;
  const hi = Math.max(...rangeBars.map((c) => c.high));
  const lo = Math.min(...rangeBars.map((c) => c.low));
  const mid = (hi + lo) / 2;
  const span = Math.max(hi - lo, Math.abs(mid) * 1e-9);
  const px =
    lastMid != null && Number.isFinite(lastMid)
      ? lastMid
      : last.close;

  const eps = Math.max(Math.abs(px) * 0.0004, span * 0.12);
  const near_high = px >= hi - eps;
  const near_low = px <= lo + eps;
  let bias: ZoneBias = 'INSIDE';
  if (px > mid + span * 0.08) bias = 'ABOVE';
  else if (px < mid - span * 0.08) bias = 'BELOW';

  const bodies = candles.slice(-12).map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  const ranges = candles.slice(-12).map(
    (c) => (c.high - c.low) / Math.max(Math.abs(c.open), 1e-9)
  );
  const persistence = mean(bodies.map((v) => (v > 0.00015 ? 1 : v < -0.00015 ? -1 : 0)));
  const avgRange = Math.max(mean(ranges), 1e-9);
  const lastRange = ranges[ranges.length - 1] ?? avgRange;
  const compressed = lastRange < avgRange * 0.65 && span / Math.max(Math.abs(mid), 1) < 0.004;

  let structure: StructureHint = 'UNKNOWN';
  if (failed) {
    structure = failed;
  } else if (last.close > hi && persistence > 0.25 && last.close - last.open > 0) {
    // Breakout = outside prior multi-minute H/L with persistence — not one stray wick
    structure = 'BREAKOUT_UP';
  } else if (last.close < lo && persistence < -0.25 && last.close - last.open < 0) {
    structure = 'BREAKOUT_DOWN';
  } else if (persistence > 0.4) {
    structure = 'TREND_UP';
  } else if (persistence < -0.4) {
    structure = 'TREND_DOWN';
  } else if (
    compressed ||
    Math.abs(persistence) < 0.3 ||
    (px <= hi && px >= lo)
  ) {
    structure = 'RANGE';
  } else {
    structure = 'RANGE';
  }

  return {
    ready: true,
    high: hi,
    low: lo,
    mid,
    span,
    bias,
    near_high,
    near_low,
    structure,
    bar_count: candles.length,
    updated_at: new Date().toISOString(),
    detail: `1m×${candles.length} · ${structure} · H${hi.toFixed(2)} L${lo.toFixed(2)} · bias ${bias}`,
  };
}

/** FADE edge against real minute zones (not 10s micro window). */
export function nearRealZoneEdge(
  zones: MarketZoneBook,
  edge: 'low' | 'high'
): boolean {
  if (!zones.ready) return false;
  return edge === 'low' ? zones.near_low : zones.near_high;
}

/** When 10s regime lags a real minute move, follow structure for entry. */
export function regimeForEntry(
  regime10s: string | null | undefined,
  zones: MarketZoneBook
): { regime: RegimeName; led: boolean; reason: string } {
  const r = normalizeRegime(regime10s);
  if (!zones.ready) {
    return { regime: r, led: false, reason: `10s ${r} · zones not ready` };
  }
  // RANGE / COMPRESSION / micro FAILED labels lag real minute structure — follow zones
  const lagging =
    r === 'RANGE' ||
    r === 'COMPRESSION' ||
    r === 'FAILED_BREAKOUT_UP' ||
    r === 'FAILED_BREAKOUT_DOWN';
  if (!lagging) {
    return { regime: r, led: false, reason: `10s ${r}` };
  }
  const s = zones.structure;
  if (s === 'FAILED_BREAKOUT_UP') {
    return {
      regime: 'FAILED_BREAKOUT_UP',
      led: true,
      reason: `zone-led FAILED_BREAKOUT_UP (1m×${zones.bar_count}, not 10s micro)`,
    };
  }
  if (s === 'FAILED_BREAKOUT_DOWN') {
    return {
      regime: 'FAILED_BREAKOUT_DOWN',
      led: true,
      reason: `zone-led FAILED_BREAKOUT_DOWN (1m×${zones.bar_count}, not 10s micro)`,
    };
  }
  if (s === 'BREAKOUT_UP') {
    return { regime: 'BREAKOUT_UP', led: true, reason: `zone-led BREAKOUT_UP (10s was ${r})` };
  }
  if (s === 'BREAKOUT_DOWN') {
    return { regime: 'BREAKOUT_DOWN', led: true, reason: `zone-led BREAKOUT_DOWN (10s was ${r})` };
  }
  if (s === 'TREND_UP') {
    return { regime: 'TREND_UP', led: true, reason: `zone-led TREND_UP (10s was ${r})` };
  }
  if (s === 'TREND_DOWN') {
    return { regime: 'TREND_DOWN', led: true, reason: `zone-led TREND_DOWN (10s was ${r})` };
  }
  // 10s said failed-break but minutes disagree → do not keep the fake label
  if (r === 'FAILED_BREAKOUT_UP' || r === 'FAILED_BREAKOUT_DOWN') {
    return { regime: 'RANGE', led: true, reason: `drop fake 10s ${r} · minute structure ${s}` };
  }
  return { regime: r, led: false, reason: `10s ${r} · structure ${s}` };
}

export function zonesSupportLong(zones?: MarketZoneBook | null): boolean {
  if (!zones?.ready) return false;
  return zones.structure === 'TREND_UP' || zones.structure === 'BREAKOUT_UP';
}

export function zonesSupportShort(zones?: MarketZoneBook | null): boolean {
  if (!zones?.ready) return false;
  return zones.structure === 'TREND_DOWN' || zones.structure === 'BREAKOUT_DOWN';
}

/**
 * 1m zones decide WHICH side is allowed. 10s MOVE only times the fill.
 * Not a "wait forever" gate — RANGE mid simply has no side until edge.
 */
export function allowedSidesFromZones(zones: MarketZoneBook): {
  buy: boolean;
  sell: boolean;
  playbook: 'LONG' | 'SCALP' | 'FADE' | 'WAIT';
  reason: string;
} {
  if (!zones.ready) {
    return { buy: false, sell: false, playbook: 'WAIT', reason: `ZONES seeding · ${zones.detail}` };
  }
  const s = zones.structure;
  if (s === 'BREAKOUT_UP') {
    return { buy: true, sell: false, playbook: 'SCALP', reason: `zones BREAKOUT_UP → BUY only` };
  }
  if (s === 'BREAKOUT_DOWN') {
    return { buy: false, sell: true, playbook: 'SCALP', reason: `zones BREAKOUT_DOWN → SELL only` };
  }
  // Real failed break = fade back into multi-minute zone (not 10s micro fail)
  if (s === 'FAILED_BREAKOUT_UP') {
    return {
      buy: false,
      sell: true,
      playbook: 'FADE',
      reason: `zones FAILED_BREAKOUT_UP (1m×${zones.bar_count}) → FADE SELL`,
    };
  }
  if (s === 'FAILED_BREAKOUT_DOWN') {
    return {
      buy: true,
      sell: false,
      playbook: 'FADE',
      reason: `zones FAILED_BREAKOUT_DOWN (1m×${zones.bar_count}) → FADE BUY`,
    };
  }
  if (s === 'TREND_UP') {
    return { buy: true, sell: false, playbook: 'LONG', reason: `zones TREND_UP → BUY only` };
  }
  if (s === 'TREND_DOWN') {
    return { buy: false, sell: true, playbook: 'LONG', reason: `zones TREND_DOWN → SELL only` };
  }
  // Real range from multi-minute H/L — fade edges only (not bias-from-one-bar)
  if (s === 'RANGE' || s === 'UNKNOWN') {
    return {
      buy: zones.near_low,
      sell: zones.near_high,
      playbook: zones.near_low || zones.near_high ? 'FADE' : 'WAIT',
      reason: zones.near_low
        ? `zones RANGE edge-low → FADE BUY`
        : zones.near_high
          ? `zones RANGE edge-high → FADE SELL`
          : `zones RANGE mid H${zones.high.toFixed(2)}/L${zones.low.toFixed(2)} · wait edge`,
    };
  }
  return { buy: false, sell: false, playbook: 'WAIT', reason: `zones ${s} · no side` };
}

/**
 * Regime (10s or zone-led) must agree with minute structure before entry.
 * Returns ok=false → WAIT (structure first).
 */
export function regimeConfirmedByZones(
  regime10s: string | null | undefined,
  zones: MarketZoneBook
): { ok: boolean; reason: string } {
  if (!zones.ready) {
    return { ok: false, reason: `ZONES seeding · ${zones.detail}` };
  }

  const r = normalizeRegime(regime10s);

  if (r === 'COMPRESSION') {
    return { ok: false, reason: `WAIT regime COMPRESSION · structure ${zones.structure}` };
  }

  const s = zones.structure;

  // LONG family — need bullish / bearish structure alignment
  if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND') {
    if (s === 'TREND_DOWN' || s === 'BREAKOUT_DOWN') {
      return {
        ok: false,
        reason: `BLOCK · 10s ${r} vs minute ${s} (no LONG until structure agrees)`,
      };
    }
    return { ok: true, reason: `OK · ${r} + ${s}` };
  }
  if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND') {
    if (s === 'TREND_UP' || s === 'BREAKOUT_UP') {
      return {
        ok: false,
        reason: `BLOCK · 10s ${r} vs minute ${s} (no LONG until structure agrees)`,
      };
    }
    return { ok: true, reason: `OK · ${r} + ${s}` };
  }

  // SCALP breakout — need break or matching expansion bias
  if (r === 'BREAKOUT_UP') {
    if (s === 'BREAKOUT_UP' || s === 'TREND_UP' || zones.bias === 'ABOVE' || zones.near_high) {
      return { ok: true, reason: `OK · ${r} + ${s}` };
    }
    return { ok: false, reason: `BLOCK · 10s BREAKOUT_UP vs minute ${s}` };
  }
  if (r === 'BREAKOUT_DOWN') {
    if (s === 'BREAKOUT_DOWN' || s === 'TREND_DOWN' || zones.bias === 'BELOW' || zones.near_low) {
      return { ok: true, reason: `OK · ${r} + ${s}` };
    }
    return { ok: false, reason: `BLOCK · 10s BREAKOUT_DOWN vs minute ${s}` };
  }

  if (r === 'EXPANSION' || r === 'REVERSAL_CANDIDATE') {
    if (s === 'RANGE' && !zones.near_high && !zones.near_low) {
      return { ok: false, reason: `BLOCK · ${r} in quiet minute RANGE mid` };
    }
    return { ok: true, reason: `OK · ${r} + ${s}` };
  }

  // FADE — only when minute structure is range-like (or failed break back inside)
  if (r === 'RANGE') {
    if (s === 'TREND_UP' || s === 'TREND_DOWN' || s === 'BREAKOUT_UP' || s === 'BREAKOUT_DOWN') {
      return {
        ok: false,
        reason: `BLOCK · 10s RANGE vs minute ${s} (FADE only in real range)`,
      };
    }
    if (!zones.near_high && !zones.near_low) {
      return { ok: false, reason: `BLOCK · RANGE mid-zone · wait edge H${zones.high.toFixed(2)}/L${zones.low.toFixed(2)}` };
    }
    return { ok: true, reason: `OK · RANGE edge + ${s}` };
  }

  if (r === 'FAILED_BREAKOUT_UP' || r === 'FAILED_BREAKOUT_DOWN') {
    // 10s micro "fail" is not enough — minutes must show real multi-bar fail
    if (s === r) return { ok: true, reason: `OK · minute ${s}` };
    return {
      ok: false,
      reason: `BLOCK · 10s ${r} without minute failed-break (structure ${s})`,
    };
  }

  return { ok: false, reason: `BLOCK · unhandled ${r}` };
}

/** Map structure hint toward a regime name for diagnostics. */
export function structureAsRegime(s: StructureHint): RegimeName {
  if (s === 'UNKNOWN') return 'RANGE';
  return s as RegimeName;
}
