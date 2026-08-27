/**
 * Structure zones — pivots / reaction / rejection / displacement, not range-third DEMAND/SUPPLY.
 */
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';
import { findPivots, analyzeMarketStructure } from './marketStructure.js';
import { atrWilder, magnitudeFloor } from './volatilityNorm.js';
import { realBarsOnly } from './ohlcQuality.js';

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

const MIN_WIDTH_PCT = 0.00025;
const MAX_WIDTH_PCT = 0.01;
const MIN_ZONE_BARS = 8;
/** Last 150 × 10s candles (~25 minutes) — HTF seed / location. */
export const ZONE_WINDOW = 150;

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

function minWidthPt(mid: number): number {
  return Math.max(magnitudeFloor(mid), Math.abs(mid) * 0.0002);
}

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
  const real = realBarsOnly(window);
  const structSource = real.length >= 6 ? real : window;
  const struct = structSource.length > 10 ? structSource.slice(0, -2) : structSource.slice(0, -1);
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

  const pivots = findPivots(struct, 2, 2);
  const pivotHighs = pivots.filter((p) => p.kind === 'HIGH').map((p) => p.price);
  const pivotLows = pivots.filter((p) => p.kind === 'LOW').map((p) => p.price);

  const high =
    pivotHighs.length >= 1
      ? Math.max(...pivotHighs)
      : Math.max(...struct.map((b) => b.high));
  const low =
    pivotLows.length >= 1
      ? Math.min(...pivotLows)
      : Math.min(...struct.map((b) => b.low));
  const mid = (high + low) / 2;
  const width_pts = high - low;
  const width_pct = width_pts / Math.max(Math.abs(mid), 1e-9);
  const minW = Math.max(MIN_WIDTH_PCT, minWidthPt(mid) / Math.max(Math.abs(mid), 1e-9));
  if (width_pct < minW) {
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
  const zone = composeStructureZone(window, struct, high, low, pivots.length, nowMs);
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

function composeStructureZone(
  window: TenSecBar[],
  struct: TenSecBar[],
  high: number,
  low: number,
  pivotCount: number,
  nowMs: number
): ScalpZone {
  const mid = (high + low) / 2;
  const width = high - low;
  const width_pct = width / Math.max(Math.abs(mid), 1e-9);
  const last = window[window.length - 1]!;
  const atr = atrWilder(struct, 14);
  const ms = analyzeMarketStructure(struct);

  let kind: ZoneKind = 'BOX';
  const nearLow = last.low <= low + width * 0.2 || last.close <= low + width * 0.25;
  const nearHigh = last.high >= high - width * 0.2 || last.close >= high - width * 0.25;
  const bullReact =
    ms.events.some((e) => e.kind === 'RECLAIM' && e.side === 'BULL') ||
    ms.events.some((e) => e.kind === 'SWEEP' && e.side === 'BULL');
  const bearReact =
    ms.events.some((e) => e.kind === 'RECLAIM' && e.side === 'BEAR') ||
    ms.events.some((e) => e.kind === 'SWEEP' && e.side === 'BEAR');

  if ((nearLow && (bullReact || last.close > last.open)) || (ms.trend === 'UP' && nearLow)) {
    kind = 'DEMAND';
  } else if (
    (nearHigh && (bearReact || last.close < last.open)) ||
    (ms.trend === 'DOWN' && nearHigh)
  ) {
    kind = 'SUPPLY';
  }

  const ranges = struct.map(rangePct);
  const avgR = ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1);
  const quiet = avgR < width_pct * 0.85;

  return {
    kind,
    high,
    low,
    mid,
    width_pct,
    bars_used: struct.length,
    formed_at_ms: struct[0]!.open_time_ms,
    detail: `${kind} ${low.toFixed(2)}–${high.toFixed(2)} · pivots=${pivotCount} · w=${(width_pct * 100).toFixed(3)}% · ${struct.length} struct${
      quiet ? ' · base' : ''
    }${atr != null ? ` · ATR ${atr.toFixed(3)}` : ''} · age ${Math.max(0, Math.round((nowMs - struct[0]!.open_time_ms) / 1000))}s`,
  };
}

export function buildScalpZone(
  bars: TenSecBar[] | null | undefined,
  nowMs = Date.now()
): ScalpZone | null {
  return diagnoseZoneBuild(bars, nowMs).zone;
}

function brokeAbove(bars: TenSecBar[], level: number): boolean {
  return bars.slice(-4).some((b) => b.close > level);
}

function brokeBelow(bars: TenSecBar[], level: number): boolean {
  return bars.slice(-4).some((b) => b.close < level);
}

export function evaluateZoneEntry(
  direction: 'BUY' | 'SELL',
  bar: TenSecBar,
  zone: ScalpZone,
  priorBars?: TenSecBar[] | null
): ZoneVerdict {
  const hist = [...(priorBars ?? []), bar];
  const band = (zone.high - zone.low) * 0.2;
  const bp = bodyPct(bar);

  if (direction === 'BUY') {
    if (bar.close > zone.high && bar.open <= zone.high + band * 0.5) {
      if (bar.high > zone.high && bar.close <= zone.high) {
        return { ok: false, setup: null, reason: 'ZONE · wick-only ≠ breakout' };
      }
      if (bp > 0.0015) {
        return { ok: false, setup: null, reason: 'ZONE · breakout bar exhausted — no chase' };
      }
      return {
        ok: true,
        setup: 'BREAKOUT',
        reason: `ZONE BREAKOUT ↑ through ${zone.high.toFixed(2)} · ${zone.detail}`,
      };
    }
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

  if (bar.close < zone.low && bar.open >= zone.low - band * 0.5) {
    if (bar.low < zone.low && bar.close >= zone.low) {
      return { ok: false, setup: null, reason: 'ZONE · wick-only ≠ breakout' };
    }
    if (bp < -0.0015) {
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
    return `ZONE OK · ${zone.kind} ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} · ${zone.bars_used}/${ZONE_WINDOW} struct · w=${(zone.width_pct * 100).toFixed(3)}% (${wPt}pt)`;
  }
  const d = diagnoseZoneBuild(bars);
  const wPct = d.width_pct != null ? `${(d.width_pct * 100).toFixed(3)}%` : '—';
  const wPt = d.width_pts != null ? `${d.width_pts.toFixed(1)}pt` : '—';
  switch (d.status) {
    case 'SEEDING':
      return `ZONE seeding · ${d.closed_bars}/${d.min_bars}×10s closed (need ${Math.max(0, d.min_bars - d.closed_bars)} more · ~${Math.max(0, d.min_bars - d.closed_bars) * 10}s)`;
    case 'TOO_NARROW':
      return `ZONE invalid · ${d.closed_bars} bars · band ${wPt} ${wPct} too tight — micro noise`;
    case 'TOO_WIDE':
      return `ZONE invalid · ${d.closed_bars} bars · band ${wPt} ${wPct} too wide (max ${(MAX_WIDTH_PCT * 100).toFixed(3)}%) — trending not box`;
    case 'NO_STRUCT':
      return `ZONE invalid · ${d.closed_bars} bars · only ${d.struct_bars} struct bars (need ≥6 in ${ZONE_WINDOW}-bar window)`;
    default:
      return `ZONE · unknown state · ${d.closed_bars} bars`;
  }
}
