/**
 * 10s scalp zones — structure before entry.
 * Built from closed 10s bars (~2–3 min lookback). Not candle-color.
 */
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';

export type ZoneKind = 'BOX' | 'DEMAND' | 'SUPPLY';

export type ScalpZone = {
  kind: ZoneKind;
  high: number;
  low: number;
  mid: number;
  width_pct: number;
  bars_used: number;
  formed_at_ms: number;
  detail: string;
};

export type ZoneSetup = 'BREAKOUT' | 'RETEST' | 'BOUNCE' | 'REJECT';

export type ZoneVerdict = {
  ok: boolean;
  setup: ZoneSetup | null;
  reason: string;
};

/** Scalp box: Gold@4640 → min ~1.0pt (was 0.04% ≈1.85pt — blocked most overnight). */
const MIN_WIDTH_PCT = 0.00025;
/** Point floor for metals — 1.3pt band must qualify on Gold. */
const MIN_WIDTH_PT = 1.0;
const MAX_WIDTH_PCT = 0.004;
const MIN_ZONE_BARS = 8;
const ZONE_WINDOW = 18;

export type ZoneBuildStatus =
  | 'READY'
  | 'SEEDING'
  | 'NO_STRUCT'
  | 'TOO_NARROW'
  | 'TOO_WIDE';

export type ZoneBuildDiag = {
  zone: ScalpZone | null;
  closed_bars: number;
  min_bars: number;
  struct_bars: number;
  width_pct: number | null;
  width_pts: number | null;
  status: ZoneBuildStatus;
};

/** Why zone is null or ready — for honest INFO. */
export function diagnoseZoneBuild(
  bars: TenSecBar[] | null | undefined,
  nowMs = Date.now()
): ZoneBuildDiag {
  const closed_bars = bars?.length ?? 0;
  if (!bars || closed_bars < MIN_ZONE_BARS) {
    return {
      zone: null,
      closed_bars,
      min_bars: MIN_ZONE_BARS,
      struct_bars: 0,
      width_pct: null,
      width_pts: null,
      status: 'SEEDING',
    };
  }
  const window = bars.slice(-ZONE_WINDOW);
  const struct = window.length > 10 ? window.slice(0, -2) : window.slice(0, -1);
  if (struct.length < 6) {
    return {
      zone: null,
      closed_bars,
      min_bars: MIN_ZONE_BARS,
      struct_bars: struct.length,
      width_pct: null,
      width_pts: null,
      status: 'NO_STRUCT',
    };
  }
  const high = Math.max(...struct.map((b) => b.high));
  const low = Math.min(...struct.map((b) => b.low));
  const mid = (high + low) / 2;
  const width_pts = high - low;
  const width_pct = width_pts / Math.max(Math.abs(mid), 1e-9);
  const minWidthPct = Math.max(MIN_WIDTH_PCT, MIN_WIDTH_PT / Math.max(Math.abs(mid), 1e-9));
  if (width_pct < minWidthPct) {
    return {
      zone: null,
      closed_bars,
      min_bars: MIN_ZONE_BARS,
      struct_bars: struct.length,
      width_pct,
      width_pts,
      status: 'TOO_NARROW',
    };
  }
  if (width_pct > MAX_WIDTH_PCT) {
    return {
      zone: null,
      closed_bars,
      min_bars: MIN_ZONE_BARS,
      struct_bars: struct.length,
      width_pct,
      width_pts,
      status: 'TOO_WIDE',
    };
  }
  const zone = composeScalpZone(window, struct, nowMs);
  return {
    zone,
    closed_bars,
    min_bars: MIN_ZONE_BARS,
    struct_bars: struct.length,
    width_pct,
    width_pts,
    status: 'READY',
  };
}

function composeScalpZone(
  window: TenSecBar[],
  struct: TenSecBar[],
  nowMs: number
): ScalpZone {
  const high = Math.max(...struct.map((b) => b.high));
  const low = Math.min(...struct.map((b) => b.low));
  const mid = (high + low) / 2;
  const width = high - low;
  const width_pct = width / Math.max(Math.abs(mid), 1e-9);
  const last = window[window.length - 1]!;
  const third = width / 3;
  let kind: ZoneKind = 'BOX';
  if (last.close <= low + third) kind = 'DEMAND';
  else if (last.close >= high - third) kind = 'SUPPLY';

  const ranges = struct.map(rangePct);
  const avgR = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const quiet = avgR < width_pct * 0.85;

  return {
    kind,
    high,
    low,
    mid,
    width_pct,
    bars_used: struct.length,
    formed_at_ms: struct[0]!.open_time_ms,
    detail: `${kind} ${low.toFixed(2)}–${high.toFixed(2)} · w=${(width_pct * 100).toFixed(3)}% · ${struct.length} struct bars${
      quiet ? ' · base' : ''
    } · age ${Math.max(0, Math.round((nowMs - struct[0]!.open_time_ms) / 1000))}s`,
  };
}

export function buildScalpZone(
  bars: TenSecBar[] | null | undefined,
  nowMs = Date.now()
): ScalpZone | null {
  return diagnoseZoneBuild(bars, nowMs).zone;
}

function brokeAbove(bars: TenSecBar[], level: number): boolean {
  return bars.slice(-4).some((b) => b.close > level || b.high > level);
}

function brokeBelow(bars: TenSecBar[], level: number): boolean {
  return bars.slice(-4).some((b) => b.close < level || b.low < level);
}

/**
 * Zone must agree with intended side — no random color follow outside structure.
 */
export function evaluateZoneEntry(
  direction: 'BUY' | 'SELL',
  bar: TenSecBar,
  zone: ScalpZone,
  priorBars?: TenSecBar[] | null
): ZoneVerdict {
  const hist = [...(priorBars ?? []), bar];
  const band = (zone.high - zone.low) * 0.35;
  const bp = bodyPct(bar);

  if (direction === 'BUY') {
    // Fresh breakout through supply/box high
    if (bar.close > zone.high && bar.open <= zone.high + band * 0.5) {
      if (bp > 0.0035) {
        return { ok: false, setup: null, reason: 'ZONE · breakout bar exhausted — no chase' };
      }
      return {
        ok: true,
        setup: 'BREAKOUT',
        reason: `ZONE BREAKOUT ↑ through ${zone.high.toFixed(2)} · ${zone.detail}`,
      };
    }
    // Retest: already broke above, now dips into top of zone and holds
    if (
      brokeAbove(hist.slice(0, -1), zone.high) &&
      bar.low <= zone.high + band * 0.15 &&
      bar.low >= zone.mid &&
      bar.close > zone.mid &&
      bar.close >= bar.open
    ) {
      return {
        ok: true,
        setup: 'RETEST',
        reason: `ZONE RETEST ↑ hold ${zone.high.toFixed(2)} · ${zone.detail}`,
      };
    }
    // Demand bounce from box low
    if (
      bar.low <= zone.low + band &&
      bar.low >= zone.low - band * 0.5 &&
      bar.close > zone.low &&
      bar.close >= bar.open
    ) {
      return {
        ok: true,
        setup: 'BOUNCE',
        reason: `ZONE BOUNCE demand ${zone.low.toFixed(2)} · ${zone.detail}`,
      };
    }
    return {
      ok: false,
      setup: null,
      reason: `ZONE wait BUY · price vs ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} (${zone.kind})`,
    };
  }

  // SELL
  if (bar.close < zone.low && bar.open >= zone.low - band * 0.5) {
    if (bp < -0.0035) {
      return { ok: false, setup: null, reason: 'ZONE · breakdown bar exhausted — no chase' };
    }
    return {
      ok: true,
      setup: 'BREAKOUT',
      reason: `ZONE BREAKOUT ↓ through ${zone.low.toFixed(2)} · ${zone.detail}`,
    };
  }
  if (
    brokeBelow(hist.slice(0, -1), zone.low) &&
    bar.high >= zone.low - band * 0.15 &&
    bar.high <= zone.mid &&
    bar.close < zone.mid &&
    bar.close <= bar.open
  ) {
    return {
      ok: true,
      setup: 'RETEST',
      reason: `ZONE RETEST ↓ hold ${zone.low.toFixed(2)} · ${zone.detail}`,
    };
  }
  if (
    bar.high >= zone.high - band &&
    bar.high <= zone.high + band * 0.5 &&
    bar.close < zone.high &&
    bar.close <= bar.open
  ) {
    return {
      ok: true,
      setup: 'REJECT',
      reason: `ZONE REJECT supply ${zone.high.toFixed(2)} · ${zone.detail}`,
    };
  }
  return {
    ok: false,
    setup: null,
    reason: `ZONE wait SELL · price vs ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} (${zone.kind})`,
  };
}

export function formatZoneInfo(
  zone: ScalpZone | null,
  bars?: TenSecBar[] | null | undefined
): string {
  if (zone) {
    const wPt = (zone.high - zone.low).toFixed(1);
    return `ZONE OK · ${zone.kind} ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} · ${zone.bars_used} struct · w=${(zone.width_pct * 100).toFixed(3)}% (${wPt}pt)`;
  }
  const d = diagnoseZoneBuild(bars);
  const wPct = d.width_pct != null ? `${(d.width_pct * 100).toFixed(3)}%` : '—';
  const wPt = d.width_pts != null ? `${d.width_pts.toFixed(1)}pt` : '—';
  switch (d.status) {
    case 'SEEDING':
      return `ZONE seeding · ${d.closed_bars}/${d.min_bars}×10s closed (need ${Math.max(0, d.min_bars - d.closed_bars)} more · ~${Math.max(0, d.min_bars - d.closed_bars) * 10}s)`;
    case 'TOO_NARROW':
      return `ZONE invalid · ${d.closed_bars} bars · band ${wPt} ${wPct} too tight (min ${MIN_WIDTH_PT}pt) — micro noise`;
    case 'TOO_WIDE':
      return `ZONE invalid · ${d.closed_bars} bars · band ${wPt} ${wPct} too wide (max ${(MAX_WIDTH_PCT * 100).toFixed(3)}%) — trending not box`;
    case 'NO_STRUCT':
      return `ZONE invalid · ${d.closed_bars} bars · only ${d.struct_bars} struct bars (need ≥6 in ${ZONE_WINDOW}-bar window)`;
    default:
      return `ZONE · unknown state · ${d.closed_bars} bars`;
  }
}
