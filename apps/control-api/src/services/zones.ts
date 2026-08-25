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

/** Scalp box: not micro-noise, not a runaway range. Gold@4500 → ~1.8–18pt. */
const MIN_WIDTH_PCT = 0.0004;
const MAX_WIDTH_PCT = 0.004;

export function buildScalpZone(
  bars: TenSecBar[] | null | undefined,
  nowMs = Date.now()
): ScalpZone | null {
  if (!bars || bars.length < 8) return null;
  const window = bars.slice(-18);
  // Structure from older bars; leave last 1–2 for reaction
  const struct = window.length > 10 ? window.slice(0, -2) : window.slice(0, -1);
  if (struct.length < 6) return null;

  const high = Math.max(...struct.map((b) => b.high));
  const low = Math.min(...struct.map((b) => b.low));
  const mid = (high + low) / 2;
  const width = high - low;
  const width_pct = width / Math.max(Math.abs(mid), 1e-9);
  if (width_pct < MIN_WIDTH_PCT || width_pct > MAX_WIDTH_PCT) return null;

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
    detail: `${kind} ${low.toFixed(2)}–${high.toFixed(2)} · w=${(width_pct * 100).toFixed(3)}% · ${struct.length} bars${
      quiet ? ' · base' : ''
    } · age ${Math.max(0, Math.round((nowMs - struct[0]!.open_time_ms) / 1000))}s`,
  };
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

export function formatZoneInfo(zone: ScalpZone | null): string {
  if (!zone) return 'ZONE · forming (need ≥8×10s bars in band)';
  return `ZONE · ${zone.detail}`;
}
