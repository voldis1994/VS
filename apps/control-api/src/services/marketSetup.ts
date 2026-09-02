/**
 * Setup-first market model (LIVE desk brain).
 *
 * Capital quote + 1m (+ optional 1h) + 10s → STRUCTURE → SETUP → ENTRY → BEST OUTCOME
 *
 * Hard rules:
 * - Setup changes only on structure refresh / closed bars — never on every quote tick
 * - NONE = no tradeable setup (not a "WAIT regime")
 * - ARMED = setup ready; entry only on closed 10s confirm at the level
 * - Open trade freezes setup; manage = best outcome only
 */
import type { CapitalPriceCandle } from './capitalCom.js';
import { edgeEps, minSwingSpan, scaleFromGold, refPx } from './instrumentScale.js';
import type { TradePlaybook } from './playbooks.js';
import { PLAYBOOK_ENTRY_BODY } from './playbooks.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';

export const SETUP_KINDS = [
  'CONTINUATION',
  'PULLBACK',
  'BREAKOUT',
  'FADE',
  'FAILED_BREAK',
  'NONE',
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

export type SetupStatus = 'NONE' | 'FORMING' | 'ARMED';

export type StructureBook = {
  ready: boolean;
  swing_high: number;
  swing_low: number;
  mid: number;
  span: number;
  bias: 'ABOVE' | 'BELOW' | 'INSIDE';
  near_high: boolean;
  near_low: boolean;
  hour_bias: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
  bar_count: number;
  detail: string;
  updated_at: string;
};

export type MarketSetup = {
  kind: SetupKind;
  side: 'BUY' | 'SELL' | null;
  playbook: TradePlaybook | null;
  status: SetupStatus;
  swing_high: number;
  swing_low: number;
  reason: string;
  /** Sticky confirm counter — setup flips only after enough agreeing updates */
  confirm: number;
  updated_at: string;
  /** Both sides watched at once — desk shows BUY & SELL candidates */
  watch_buy?: string | null;
  watch_sell?: string | null;
};

export type SetupEntry = {
  direction: 'BUY' | 'SELL';
  setup: SetupKind;
  playbook: TradePlaybook;
  reason: string;
};

const MIN_SWING_BARS = 20;
const PIVOT_LEFT = 3;
const PIVOT_RIGHT = 3;
const SETUP_CONFIRM = 2;
/** FADE / FAILED_BREAK only if swing extreme printed within this many 1m bars */
const FRESH_SWING_BARS = 12;

/**
 * Swing high/low is fresh only if a recent 1m bar actually printed that extreme.
 * Blocks FADE SELL on a stale H mid-rally (4434 while climb continues to 4437)
 * and FADE BUY on a stale L mid-dump.
 */
export function isFreshSwingHigh(
  minutes: CapitalPriceCandle[],
  hi: number,
  eps: number,
  maxAgeBars = FRESH_SWING_BARS
): boolean {
  if (!(hi > 0) || minutes.length < 2) return false;
  const slice = minutes.slice(-Math.max(2, maxAgeBars));
  return slice.some((c) => c.high >= hi - eps * 0.2);
}

export function isFreshSwingLow(
  minutes: CapitalPriceCandle[],
  lo: number,
  eps: number,
  maxAgeBars = FRESH_SWING_BARS
): boolean {
  if (!(lo > 0) || minutes.length < 2) return false;
  const slice = minutes.slice(-Math.max(2, maxAgeBars));
  return slice.some((c) => c.low <= lo + eps * 0.2);
}

export function emptyStructure(detail = 'structure seeding'): StructureBook {
  return {
    ready: false,
    swing_high: 0,
    swing_low: 0,
    mid: 0,
    span: 0,
    bias: 'INSIDE',
    near_high: false,
    near_low: false,
    hour_bias: 'UNKNOWN',
    bar_count: 0,
    detail,
    updated_at: new Date().toISOString(),
  };
}

export function emptySetup(reason = 'no setup'): MarketSetup {
  return {
    kind: 'NONE',
    side: null,
    playbook: null,
    status: 'NONE',
    swing_high: 0,
    swing_low: 0,
    reason,
    confirm: 0,
    updated_at: new Date().toISOString(),
    watch_buy: null,
    watch_sell: null,
  };
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Last swing high/low from minute pivots — remembered structure, not raw rolling max. */
export function detectSwingLevels(minutes: CapitalPriceCandle[]): {
  high: number;
  low: number;
  ok: boolean;
} {
  if (minutes.length < MIN_SWING_BARS) {
    return { high: 0, low: 0, ok: false };
  }
  const pivotsHi: number[] = [];
  const pivotsLo: number[] = [];
  for (let i = PIVOT_LEFT; i < minutes.length - PIVOT_RIGHT; i++) {
    const c = minutes[i]!;
    let isHi = true;
    let isLo = true;
    for (let j = i - PIVOT_LEFT; j <= i + PIVOT_RIGHT; j++) {
      if (j === i) continue;
      const o = minutes[j]!;
      if (o.high >= c.high) isHi = false;
      if (o.low <= c.low) isLo = false;
    }
    if (isHi) pivotsHi.push(c.high);
    if (isLo) pivotsLo.push(c.low);
  }
  // Prefer recent pivots; fall back to window extremes if sparse
  const high =
    pivotsHi.length > 0
      ? pivotsHi[pivotsHi.length - 1]!
      : Math.max(...minutes.slice(0, -1).map((c) => c.high));
  const low =
    pivotsLo.length > 0
      ? pivotsLo[pivotsLo.length - 1]!
      : Math.min(...minutes.slice(0, -1).map((c) => c.low));
  if (!(high > low)) return { high: 0, low: 0, ok: false };
  return { high, low, ok: true };
}

function hourBiasFrom(hours: CapitalPriceCandle[] | null | undefined): StructureBook['hour_bias'] {
  if (!hours || hours.length < 3) return 'UNKNOWN';
  const last = hours.slice(-6);
  const bodies = last.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  const p = mean(bodies.map((v) => (v > 0.0002 ? 1 : v < -0.0002 ? -1 : 0)));
  if (p > 0.35) return 'UP';
  if (p < -0.35) return 'DOWN';
  return 'FLAT';
}

/**
 * Build durable structure from Capital minutes (+ optional hours).
 * Optional prevSwing keeps levels sticky across refreshes until clearly broken.
 */
export function buildStructure(input: {
  minutes: CapitalPriceCandle[];
  hours?: CapitalPriceCandle[] | null;
  mid?: number | null;
  prev?: StructureBook | null;
}): StructureBook {
  const { minutes, hours, mid: lastMid, prev } = input;
  if (!minutes.length || minutes.length < MIN_SWING_BARS) {
    return emptyStructure(`need ≥${MIN_SWING_BARS} minute bars · have ${minutes.length}`);
  }

  const swing = detectSwingLevels(minutes);
  if (!swing.ok) return emptyStructure('swing levels not found');

  let hi = swing.high;
  let lo = swing.low;

  // Stickiness: keep previous swing until price closes beyond it with room
  if (prev?.ready && prev.swing_high > prev.swing_low) {
    const last = minutes[minutes.length - 1]!;
    const brokeHigh = last.close > prev.swing_high * 1.00015;
    const brokeLow = last.close < prev.swing_low * 0.99985;
    if (!brokeHigh && Math.abs(hi - prev.swing_high) / Math.max(prev.swing_high, 1) < 0.002) {
      hi = prev.swing_high;
    } else if (!brokeHigh && hi < prev.swing_high) {
      // don't shrink high on noise — keep remembered resistance
      hi = prev.swing_high;
    }
    if (!brokeLow && Math.abs(lo - prev.swing_low) / Math.max(prev.swing_low, 1) < 0.002) {
      lo = prev.swing_low;
    } else if (!brokeLow && lo > prev.swing_low) {
      lo = prev.swing_low;
    }
    if (brokeHigh && swing.high > prev.swing_high) hi = swing.high;
    if (brokeLow && swing.low < prev.swing_low) lo = swing.low;
  }

  const midZ = (hi + lo) / 2;
  const span = Math.max(hi - lo, Math.abs(midZ) * 1e-9);
  const px =
    lastMid != null && Number.isFinite(lastMid)
      ? lastMid
      : minutes[minutes.length - 1]!.close;
  const eps = edgeEps(px, span);
  const near_high = px >= hi - eps;
  const near_low = px <= lo + eps;
  let bias: StructureBook['bias'] = 'INSIDE';
  if (px > midZ + span * 0.1) bias = 'ABOVE';
  else if (px < midZ - span * 0.1) bias = 'BELOW';

  const hb = hourBiasFrom(hours);

  return {
    ready: true,
    swing_high: hi,
    swing_low: lo,
    mid: midZ,
    span,
    bias,
    near_high,
    near_low,
    hour_bias: hb,
    bar_count: minutes.length,
    detail: `swing H${hi.toFixed(2)} L${lo.toFixed(2)} · ${bias} · 1h ${hb} · 1m×${minutes.length}`,
    updated_at: new Date().toISOString(),
  };
}

function persistence(minutes: CapitalPriceCandle[], n = 12): number {
  const slice = minutes.slice(-n);
  const bodies = slice.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  return mean(bodies.map((v) => (v > 0.00015 ? 1 : v < -0.00015 ? -1 : 0)));
}

/**
 * Local impulse from last few 1m bars — each V-leg must fire (dump then rally),
 * not cancel to net≈0 over a long window (that caused ZERO trades on 10s swings).
 * Must NOT fire on quiet range oscillation (false CONTINUATION).
 */
export function recentImpulse(
  minutes: CapitalPriceCandle[],
  mode: 'normal' | 'flip' = 'normal'
): 'UP' | 'DOWN' | null {
  const n = mode === 'flip' ? 3 : 5;
  const slice = minutes.slice(-n);
  if (slice.length < (mode === 'flip' ? 3 : 4)) return null;
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const pers = persistence(slice, slice.length);
  const net = last.close - first.open;
  const thr =
    mode === 'flip'
      ? Math.max(refPx(first.open) * 0.00035, scaleFromGold(first.open, 1.2))
      : Math.max(refPx(first.open) * 0.0005, scaleFromGold(first.open, 1.8));
  const persThr = mode === 'flip' ? 0.4 : 0.35;
  if (pers <= -persThr && net <= -thr) return 'DOWN';
  if (pers >= persThr && net >= thr) return 'UP';

  // Sharp last 2 minutes same direction — live V-leg without waiting for longer net
  if (slice.length >= 2) {
    const a = slice[slice.length - 2]!;
    const b = last;
    const sharp = b.close - a.open;
    const sharpThr = Math.max(refPx(a.open) * 0.00045, scaleFromGold(a.open, 2.0));
    const bothDown = a.close <= a.open && b.close < b.open;
    const bothUp = a.close >= a.open && b.close > b.open;
    if (sharp <= -sharpThr && bothDown) return 'DOWN';
    if (sharp >= sharpThr && bothUp) return 'UP';
  }
  return null;
}

/**
 * True when 1m impulse has turned against an open side — simple flip signal.
 * BUY + DOWN → close BUY, open SELL with the dump.
 * SELL + UP → close SELL, open BUY with the rally.
 */
export function isImpulseAgainstSide(
  side: 'BUY' | 'SELL' | null | undefined,
  minutes: CapitalPriceCandle[] | null | undefined
): boolean {
  if (!side || !minutes?.length) return false;
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  if (side === 'BUY' && imp === 'DOWN') return true;
  if (side === 'SELL' && imp === 'UP') return true;
  return false;
}

/**
 * Dump / rally bias including slow grinds (small red candles) that miss impulse persistence.
 * Used to hard-block BUY into dump / SELL into rally.
 */
export function priceFlowBias(
  minutes: CapitalPriceCandle[] | null | undefined
): 'UP' | 'DOWN' | null {
  if (!minutes || minutes.length < 4) return null;
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  if (imp) return imp;
  const slice = minutes.slice(-6);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const net = last.close - first.open;
  const thr = Math.max(refPx(first.open) * 0.00035, scaleFromGold(first.open, 1.4));
  // Count red vs green closes in window
  let down = 0;
  let up = 0;
  for (const c of slice) {
    if (c.close < c.open) down += 1;
    else if (c.close > c.open) up += 1;
  }
  if (net <= -thr && down >= up) return 'DOWN';
  if (net >= thr && up >= down) return 'UP';
  // Lower-high grind: last close below open of window start by thr even if mixed
  if (net <= -thr * 1.25) return 'DOWN';
  if (net >= thr * 1.25) return 'UP';
  return null;
}

/** Dual-side watch labels — desk shows both, not only the armed side. */
export function dualSideWatch(
  structure: StructureBook,
  minutes: CapitalPriceCandle[]
): { watch_buy: string | null; watch_sell: string | null } {
  if (!structure.ready || minutes.length < MIN_SWING_BARS) {
    return { watch_buy: null, watch_sell: null };
  }
  const last = minutes[minutes.length - 1]!;
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const eps = edgeEps(last.close, Math.max(hi - lo, structure.span, 1));
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const freshHi = isFreshSwingHigh(minutes, hi, eps);
  const freshLo = isFreshSwingLow(minutes, lo, eps);
  let watch_buy: string | null = null;
  let watch_sell: string | null = null;

  if (imp === 'UP' || last.close > hi || (last.close > structure.mid && structure.bias !== 'BELOW')) {
    watch_buy =
      last.close > hi
        ? `BUY break/through H${hi.toFixed(2)}`
        : `BUY cont · mid ${structure.mid.toFixed(2)}`;
  }
  if (imp === 'DOWN' || last.close < lo || (last.close < structure.mid && structure.bias !== 'ABOVE')) {
    watch_sell =
      last.close < lo
        ? `SELL break/through L${lo.toFixed(2)}`
        : `SELL cont · mid ${structure.mid.toFixed(2)}`;
  }
  if (freshHi && structure.near_high && imp !== 'UP') {
    watch_sell = `SELL fade H${hi.toFixed(2)}`;
  }
  if (freshLo && structure.near_low && imp !== 'DOWN') {
    watch_buy = `BUY fade L${lo.toFixed(2)}`;
  }
  return { watch_buy, watch_sell };
}

function rawSetupFromStructure(
  structure: StructureBook,
  minutes: CapitalPriceCandle[]
): Omit<MarketSetup, 'confirm' | 'updated_at'> {
  if (!structure.ready || minutes.length < MIN_SWING_BARS) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: structure.swing_high,
      swing_low: structure.swing_low,
      reason: structure.detail || 'structure not ready',
    };
  }

  const last = minutes[minutes.length - 1]!;
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const pers = persistence(minutes);
  const eps = edgeEps(last.close, Math.max(hi - lo, structure.span, 1));
  const closedAbove = last.close > hi;
  const closedBelow = last.close < lo;
  const pokeAbove = minutes.slice(-6).some((c) => c.high > hi && c.close <= hi);
  const pokeBelow = minutes.slice(-6).some((c) => c.low < lo && c.close >= lo);
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const freshHi = isFreshSwingHigh(minutes, hi, eps);
  const freshLo = isFreshSwingLow(minutes, lo, eps);

  // ——— IMPULSE FIRST — instant flip side, do not wait for sticky opposite to die ———
  // But NEVER arm BUY parked at ceiling / SELL parked at floor without a fresh break.
  if (imp === 'UP') {
    const atCeilingZone = last.close >= hi - eps * 0.5 || last.high >= hi - eps * 0.25;
    const lastBar: TenSecBar = {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      open_time_ms: 0,
      ticks: 1,
    };
    const breakingFreshHigh = closedAbove || isFreshBreakoutAbove(hi, lastBar, eps);
    if (atCeilingZone && !breakingFreshHigh) {
      return {
        kind: 'NONE',
        side: null,
        playbook: null,
        status: 'NONE',
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE UP at H${hi.toFixed(2)} — wait breakout above H · no BUY at tip`,
      };
    }
    if (breakingFreshHigh) {
      return {
        kind: 'BREAKOUT',
        side: 'BUY',
        playbook: 'SCALP',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE UP through H${hi.toFixed(2)} → BUY flip now`,
      };
    }
    return {
      kind: 'CONTINUATION',
      side: 'BUY',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `IMPULSE UP → BUY flip now · mid ${structure.mid.toFixed(2)}`,
    };
  }
  if (imp === 'DOWN') {
    const atFloorZone = last.close <= lo + eps * 0.5 || last.low <= lo + eps * 0.25;
    const lastBar: TenSecBar = {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      open_time_ms: 0,
      ticks: 1,
    };
    const breakingFreshLow = closedBelow || isFreshBreakdownBelow(lo, lastBar, eps);
    if (atFloorZone && !breakingFreshLow) {
      return {
        kind: 'NONE',
        side: null,
        playbook: null,
        status: 'NONE',
        swing_high: hi,
        swing_low: lo,
        reason: isBounceOffLow(minutes, lo, eps)
          ? `IMPULSE DOWN at L${lo.toFixed(2)} · bounce forming — no SELL at floor`
          : `IMPULSE DOWN at floor L${lo.toFixed(2)} — wait breakdown below L`,
      };
    }
    if (breakingFreshLow) {
      return {
        kind: 'BREAKOUT',
        side: 'SELL',
        playbook: 'SCALP',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE DOWN through L${lo.toFixed(2)} → SELL flip now`,
      };
    }
    return {
      kind: 'CONTINUATION',
      side: 'SELL',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `IMPULSE DOWN → SELL flip now · mid ${structure.mid.toFixed(2)}`,
    };
  }

  // FAILED_BREAK — only on a FRESH swing extreme, never mid-rally / mid-dump fade
  if (
    pokeAbove &&
    freshHi &&
    last.close <= hi &&
    last.close >= lo &&
    last.close < last.open
  ) {
    return {
      kind: 'FAILED_BREAK',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FAILED_BREAK at fresh swing high ${hi.toFixed(2)} → FADE SELL`,
    };
  }
  if (
    pokeBelow &&
    freshLo &&
    last.close >= lo &&
    last.close <= hi &&
    last.close > last.open
  ) {
    return {
      kind: 'FAILED_BREAK',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FAILED_BREAK at fresh swing low ${lo.toFixed(2)} → FADE BUY`,
    };
  }

  // BREAKOUT — close outside swing with persistence (no live impulse needed)
  if (closedAbove && pers > 0.2) {
    return {
      kind: 'BREAKOUT',
      side: 'BUY',
      playbook: 'SCALP',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT above ${hi.toFixed(2)} → BUY`,
    };
  }
  if (closedBelow && pers < -0.2) {
    return {
      kind: 'BREAKOUT',
      side: 'SELL',
      playbook: 'SCALP',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT below ${lo.toFixed(2)} → SELL`,
    };
  }

  // Flat compression (EUR/USD quiet: H≈L) — FADE at a fake edge blocks every entry via tip-chase
  const span = hi - lo;
  const minSpan = minSwingSpan(last.close);
  if (span < minSpan) {
    if (imp === 'UP') {
      return {
        kind: 'CONTINUATION',
        side: 'BUY',
        playbook: 'SCALP',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `COMPRESSION · tight span · 10s UP → BUY`,
      };
    }
    if (imp === 'DOWN') {
      return {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: 'SCALP',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `COMPRESSION · tight span · 10s DOWN → SELL`,
      };
    }
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · compression H${hi.toFixed(4)}/L${lo.toFixed(4)} · wait 10s move`,
    };
  }

  // FADE at FRESH swing edges only — never SELL mid-rally / BUY mid-dump on stale level
  // Also: if price is still dumping, do NOT arm FADE BUY (falling knife) — ride SELL
  const flow = priceFlowBias(minutes);
  if (structure.near_high && !closedAbove && freshHi && flow !== 'UP') {
    return {
      kind: 'FADE',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FADE SELL at fresh swing high ${hi.toFixed(2)} · no BUY at tip`,
    };
  }
  if (structure.near_high && !closedAbove && freshHi && flow === 'UP') {
    // Rally at tip without fresh break — do not BUY the ceiling
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · rally at H${hi.toFixed(2)} · wait breakout · no BUY at tip`,
    };
  }
  if (structure.near_low && !closedBelow && freshLo && flow !== 'DOWN') {
    return {
      kind: 'FADE',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FADE BUY at fresh swing low ${lo.toFixed(2)} · no SELL at floor`,
    };
  }
  if (structure.near_low && !closedBelow && freshLo && flow === 'DOWN') {
    // Dump at floor without fresh breakdown — do not SELL the trough
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · dump at L${lo.toFixed(2)} · wait breakdown · no SELL at floor`,
    };
  }

  // CONTINUATION / PULLBACK in trend (hour + minute persistence) — mid/pullback only
  const trendUp =
    pers > 0.35 || structure.hour_bias === 'UP' || structure.bias === 'ABOVE';
  const trendDown =
    pers < -0.35 || structure.hour_bias === 'DOWN' || structure.bias === 'BELOW';

  if (trendUp && !closedBelow && !structure.near_high) {
    if (last.close < structure.mid && last.close > lo) {
      return {
        kind: 'PULLBACK',
        side: 'BUY',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `PULLBACK in up structure · buy toward ${lo.toFixed(2)}`,
      };
    }
    if (pers > 0.4 && structure.bias === 'ABOVE' && last.close < hi - eps) {
      return {
        kind: 'CONTINUATION',
        side: 'BUY',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION up · above mid ${structure.mid.toFixed(2)} · below tip ${hi.toFixed(2)}`,
      };
    }
  }

  if (trendDown && !closedAbove && !structure.near_low) {
    if (last.close > structure.mid && last.close < hi) {
      return {
        kind: 'PULLBACK',
        side: 'SELL',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `PULLBACK in down structure · sell toward ${hi.toFixed(2)}`,
      };
    }
    if (pers < -0.4 && structure.bias === 'BELOW' && last.close > lo + eps) {
      return {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION down · below mid ${structure.mid.toFixed(2)} · above floor ${lo.toFixed(2)}`,
      };
    }
  }

  // Stale edge → readable NONE
  if (structure.near_high && !freshHi) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · near H${hi.toFixed(2)} but stale high · watch both sides`,
    };
  }
  if (structure.near_low && !freshLo) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · near L${lo.toFixed(2)} but stale low · watch both sides`,
    };
  }

  return {
    kind: 'NONE',
    side: null,
    playbook: null,
    status: 'NONE',
    swing_high: hi,
    swing_low: lo,
    reason: `NONE · mid swing H${hi.toFixed(2)}/L${lo.toFixed(2)} · watching BUY&SELL · no impulse yet`,
  };
}

/**
 * Sticky setup update — impulse FLIPS instantly (BUY↔SELL).
 * Dual watch always attached so desk sees both sides.
 */
export function updateSetupSticky(
  prev: MarketSetup | null | undefined,
  structure: StructureBook,
  minutes: CapitalPriceCandle[]
): MarketSetup {
  const raw = rawSetupFromStructure(structure, minutes);
  const now = new Date().toISOString();
  const prevSafe = prev || emptySetup();
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const last = minutes[minutes.length - 1];
  const watch = dualSideWatch(structure, minutes);

  const withWatch = (s: MarketSetup): MarketSetup => ({
    ...s,
    watch_buy: watch.watch_buy,
    watch_sell: watch.watch_sell,
  });

  const same =
    prevSafe.kind === raw.kind &&
    prevSafe.side === raw.side &&
    prevSafe.playbook === raw.playbook;

  if (same) {
    const confirm = Math.min(prevSafe.confirm + 1, SETUP_CONFIRM + 2);
    const status: SetupStatus =
      raw.kind === 'NONE'
        ? 'NONE'
        : confirm >= SETUP_CONFIRM
          ? raw.status === 'FORMING'
            ? 'FORMING'
            : 'ARMED'
          : 'FORMING';
    return withWatch({
      ...raw,
      status: raw.kind === 'NONE' ? 'NONE' : status,
      confirm,
      swing_high: structure.swing_high || raw.swing_high,
      swing_low: structure.swing_low || raw.swing_low,
      updated_at: now,
    });
  }

  // Impulse / breakout / continuation — INSTANT arm (flip without waiting sticky)
  if (
    raw.side &&
    (String(raw.reason).includes('IMPULSE') ||
      raw.kind === 'BREAKOUT' ||
      raw.kind === 'CONTINUATION')
  ) {
    return withWatch({
      ...raw,
      status: 'ARMED',
      confirm: SETUP_CONFIRM,
      reason:
        prevSafe.side && prevSafe.side !== raw.side
          ? `${raw.reason} · flipped from ${prevSafe.side}`
          : raw.reason,
      updated_at: now,
    });
  }

  // Leaving NONE for a real setup is instant
  if (prevSafe.kind === 'NONE' && raw.kind !== 'NONE' && raw.side) {
    return withWatch({
      ...raw,
      status: raw.status === 'FORMING' ? 'FORMING' : 'ARMED',
      confirm: SETUP_CONFIRM,
      updated_at: now,
    });
  }

  // Dump kills sticky BUY; rally kills sticky SELL; opposite raw side also flips
  const stickyBuyDead =
    prevSafe.side === 'BUY' &&
    (imp === 'DOWN' ||
      raw.side === 'SELL' ||
      (last != null &&
        prevSafe.swing_low > 0 &&
        last.close < prevSafe.swing_low - edgeEps(last.close, Math.max(structure.span, 1))));
  const stickySellDead =
    prevSafe.side === 'SELL' &&
    (imp === 'UP' ||
      raw.side === 'BUY' ||
      (last != null &&
        prevSafe.swing_high > 0 &&
        last.close > prevSafe.swing_high + edgeEps(last.close, Math.max(structure.span, 1))));

  if (stickyBuyDead || stickySellDead) {
    return withWatch({
      ...raw,
      status: raw.kind === 'NONE' ? 'NONE' : raw.status === 'FORMING' ? 'FORMING' : 'ARMED',
      confirm: raw.kind === 'NONE' ? 0 : SETUP_CONFIRM,
      reason:
        raw.reason +
        (stickyBuyDead ? ' · flipped off sticky BUY' : ' · flipped off sticky SELL'),
      updated_at: now,
    });
  }

  // Same-family candidate change — brief hold only if NOT opposite side
  if (
    prevSafe.kind !== 'NONE' &&
    prevSafe.confirm >= SETUP_CONFIRM &&
    raw.kind !== prevSafe.kind &&
    !(prevSafe.side && raw.side && prevSafe.side !== raw.side)
  ) {
    return withWatch({
      ...prevSafe,
      confirm: Math.max(0, prevSafe.confirm - 1),
      reason: `${prevSafe.reason} · holding (candidate ${raw.kind})`,
      updated_at: now,
    });
  }

  return withWatch({
    ...raw,
    status: raw.kind === 'NONE' ? 'NONE' : 'FORMING',
    confirm: 1,
    updated_at: now,
  });
}

/**
 * Entry trigger on CLOSED 10s only — confirms an ARMED setup.
 * Rejection/bounce at swing for FADE/FAILED_BREAK; impulse for BREAKOUT/CONTINUATION.
 */
/** Block tip-chase for FADE/PULLBACK at the extreme tip. */
export function isTipChaseEntry(setup: MarketSetup, bar: TenSecBar): boolean {
  if (!setup.side || setup.kind === 'NONE' || setup.kind === 'BREAKOUT' || setup.kind === 'CONTINUATION') {
    return false;
  }
  if (setup.kind !== 'FADE' && setup.kind !== 'FAILED_BREAK' && setup.kind !== 'PULLBACK') {
    return false;
  }
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  const span = hi - lo;
  if (span < minSwingSpan(bar.close)) return false;
  const eps = edgeEps(bar.close, span);
  if (setup.side === 'BUY' && bar.close >= hi - eps * 0.3) return true;
  if (setup.side === 'SELL' && bar.close <= lo + eps * 0.3) return true;
  return false;
}

/** Minimum points below swing L before a SELL leg is "fresh breakdown", not V-bottom poke. */
function minBreakBelow(lo: number, px: number, eps: number): number {
  return Math.max(eps * 0.25, scaleFromGold(px, 1.0));
}

function minBreakAbove(hi: number, px: number, eps: number): number {
  return Math.max(eps * 0.25, scaleFromGold(px, 1.0));
}

export function isFreshBreakdownBelow(lo: number, bar: TenSecBar, eps: number): boolean {
  const need = minBreakBelow(lo, bar.close, eps);
  return bar.close < lo - need || bar.low < lo - need * 1.15;
}

export function isFreshBreakoutAbove(hi: number, bar: TenSecBar, eps: number): boolean {
  const need = minBreakAbove(hi, bar.close, eps);
  return bar.close > hi + need || bar.high > hi + need * 1.15;
}

/** CONTINUATION/BREAKOUT SELL at swing floor without breaking below — classic V-bottom trap. */
export function isLegFloorChase(setup: MarketSetup, bar: TenSecBar): boolean {
  if (setup.side !== 'SELL') return false;
  if (setup.kind !== 'CONTINUATION' && setup.kind !== 'BREAKOUT') return false;
  const lo = setup.swing_low;
  const hi = setup.swing_high;
  if (!(lo > 0) || hi <= lo) return false;
  const eps = edgeEps(bar.close, Math.max(hi - lo, 1));
  const atFloor = bar.close <= lo + eps * 0.35 || bar.low <= lo + eps * 0.2;
  return atFloor && !isFreshBreakdownBelow(lo, bar, eps);
}

/** CONTINUATION/BREAKOUT BUY at swing ceiling without breaking above — chase the top. */
export function isLegCeilingChase(setup: MarketSetup, bar: TenSecBar): boolean {
  if (setup.side !== 'BUY') return false;
  if (setup.kind !== 'CONTINUATION' && setup.kind !== 'BREAKOUT') return false;
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  if (!(hi > 0) || hi <= lo) return false;
  const eps = edgeEps(bar.close, Math.max(hi - lo, 1));
  const atCeiling = bar.close >= hi - eps * 0.35 || bar.high >= hi - eps * 0.2;
  return atCeiling && !isFreshBreakoutAbove(hi, bar, eps);
}

/**
 * Block only exhausted tip-chase — NOT mid-leg continuation.
 */
export function isLateChaseOnLocalLeg(
  direction: 'BUY' | 'SELL',
  minutes: CapitalPriceCandle[] | null | undefined,
  bar: TenSecBar
): boolean {
  if (!minutes || minutes.length < 3) return false;
  const slice = minutes.slice(-3);
  const legHi = Math.max(...slice.map((c) => c.high));
  const legLo = Math.min(...slice.map((c) => c.low));
  const span = Math.max(legHi - legLo, minSwingSpan(bar.close));
  if (span < scaleFromGold(bar.close, 2.0)) return false;

  const tipBand = Math.max(span * 0.1, scaleFromGold(bar.close, 1.0));
  const last = slice[slice.length - 1]!;
  const lastRun = last.close - last.open;
  const hardRun = scaleFromGold(bar.close, 5.0);
  const liveImpulse = recentImpulse(minutes, 'flip') || recentImpulse(minutes);

  if (direction === 'BUY') {
    const progress = (bar.close - legLo) / span;
    const nearTip = bar.close >= legHi - tipBand;
    const brokeAbove = bar.close > legHi + scaleFromGold(bar.close, 0.4);

    if (brokeAbove && bar.close > bar.open) return false;
    if (liveImpulse === 'UP' && progress < 0.85 && !nearTip) return false;
    if (liveImpulse === 'UP' && progress < 0.75) return false;
    if (!nearTip && progress < 0.88) return false;

    const upperWick = last.high - Math.max(last.close, last.open);
    const rejecting =
      bar.close < bar.open ||
      upperWick >= scaleFromGold(bar.close, 1.5) ||
      (lastRun >= hardRun && bar.close >= last.high - scaleFromGold(bar.close, 1.0));
    return rejecting || progress >= 0.92;
  }

  const progress = (legHi - bar.close) / span;
  const nearTip = bar.close <= legLo + tipBand;
  const brokeBelow = bar.close < legLo - scaleFromGold(bar.close, 0.4);

  if (brokeBelow && bar.close < bar.open) return false;
  if (liveImpulse === 'DOWN' && progress < 0.85 && !nearTip) return false;
  if (liveImpulse === 'DOWN' && progress < 0.75) return false;
  if (!nearTip && progress < 0.88) return false;

  const lowerWick = Math.min(last.close, last.open) - last.low;
  const rejecting =
    bar.close > bar.open ||
    lowerWick >= scaleFromGold(bar.close, 1.5) ||
    (lastRun <= -hardRun && bar.close <= last.low + scaleFromGold(bar.close, 1.0));
  return rejecting || progress >= 0.92;
}

/** 1m bounce off swing low — block SELL into V-recovery. */
export function isBounceOffLow(
  minutes: CapitalPriceCandle[] | null | undefined,
  lo: number,
  eps: number
): boolean {
  if (!minutes || minutes.length < 2 || !(lo > 0)) return false;
  const last = minutes[minutes.length - 1]!;
  const prev = minutes[minutes.length - 2]!;
  // Close must be parked near the floor — ignore range bars that only wick the low
  const nearLow = last.close <= lo + eps * 1.5 || prev.close <= lo + eps * 1.5;
  if (!nearLow) return false;
  const touchedLow = prev.low <= lo + eps || last.low <= lo + eps;
  const greenBounce = last.close > last.open && last.close >= prev.close;
  const hammer =
    last.close > last.open &&
    last.close - last.low > Math.max((last.high - last.close) * 1.1, eps * 0.3);
  return touchedLow && (greenBounce || hammer);
}

/** 1m reject off swing high — block BUY into tip fade. */
export function isRejectOffHigh(
  minutes: CapitalPriceCandle[] | null | undefined,
  hi: number,
  eps: number
): boolean {
  if (!minutes || minutes.length < 2 || !(hi > 0)) return false;
  const last = minutes[minutes.length - 1]!;
  const prev = minutes[minutes.length - 2]!;
  // Close must be parked near the tip — ignore range bars that only wick the high
  const nearHigh = last.close >= hi - eps * 1.5 || prev.close >= hi - eps * 1.5;
  if (!nearHigh) return false;
  const touchedHigh = prev.high >= hi - eps || last.high >= hi - eps;
  const redReject = last.close < last.open && last.close <= prev.close;
  const shoot =
    last.close < last.open &&
    last.high - last.close > Math.max((last.close - last.low) * 1.1, eps * 0.3);
  return touchedHigh && (redReject || shoot);
}

export function decideEntryFromSetup(
  setup: MarketSetup,
  bar: TenSecBar,
  minutes?: CapitalPriceCandle[] | null
): SetupEntry | null {
  if (setup.kind === 'NONE' || setup.status !== 'ARMED' || !setup.side || !setup.playbook) {
    return null;
  }

  const book = setup.playbook;
  const thr = PLAYBOOK_ENTRY_BODY[book];
  const body = bodyPct(bar);
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  const eps = edgeEps(bar.close, Math.max(hi - lo, 1));
  const flow = priceFlowBias(minutes);

  // Hard: never BUY into a dump / SELL into a rally (green blip mid-dump class)
  if (setup.side === 'BUY' && flow === 'DOWN') return null;
  if (setup.side === 'SELL' && flow === 'UP') return null;

  if (isTipChaseEntry(setup, bar)) return null;
  if (setup.side === 'SELL' && isLegFloorChase(setup, bar)) return null;
  if (setup.side === 'BUY' && isLegCeilingChase(setup, bar)) return null;
  if (setup.side === 'SELL' && isBounceOffLow(minutes, lo, eps)) return null;
  if (setup.side === 'BUY' && isRejectOffHigh(minutes, hi, eps)) return null;
  if (isLateChaseOnLocalLeg(setup.side, minutes, bar)) return null;

  if (setup.kind === 'FADE' || setup.kind === 'FAILED_BREAK') {
    if (setup.side === 'BUY') {
      const touched = bar.low <= lo + eps;
      const stillDumping = bar.close < bar.open && bar.low < lo - eps * 0.5;
      if (touched && !stillDumping && body >= thr * 0.55 && bar.close > bar.open) {
        return {
          direction: 'BUY',
          setup: setup.kind,
          playbook: book,
          reason: `ENTRY · ${setup.kind} BUY bounce @ L${lo.toFixed(2)} · ${setup.reason}`,
        };
      }
      return null;
    }
    const touched = bar.high >= hi - eps;
    const stillRallying = bar.close > bar.open && bar.high > hi + eps * 0.5;
    if (touched && !stillRallying && body <= -thr * 0.55 && bar.close < bar.open) {
      return {
        direction: 'SELL',
        setup: setup.kind,
        playbook: book,
        reason: `ENTRY · ${setup.kind} SELL reject @ H${hi.toFixed(2)} · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'BREAKOUT') {
    if (setup.side === 'BUY' && body >= thr * 0.6 && isFreshBreakoutAbove(hi, bar, eps)) {
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr * 0.6 && isFreshBreakdownBelow(lo, bar, eps)) {
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT SELL · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'PULLBACK') {
    if (
      setup.side === 'BUY' &&
      body >= thr * 0.6 &&
      (bar.low <= lo + eps * 1.5 || bar.close < setup.swing_high)
    ) {
      return {
        direction: 'BUY',
        setup: 'PULLBACK',
        playbook: book,
        reason: `ENTRY · PULLBACK BUY · ${setup.reason}`,
      };
    }
    if (
      setup.side === 'SELL' &&
      body <= -thr * 0.6 &&
      (bar.high >= hi - eps * 1.5 || bar.close > setup.swing_low)
    ) {
      return {
        direction: 'SELL',
        setup: 'PULLBACK',
        playbook: book,
        reason: `ENTRY · PULLBACK SELL · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'CONTINUATION') {
    if (setup.side === 'BUY' && body >= thr * 0.55) {
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr * 0.55) {
      return {
        direction: 'SELL',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION SELL · ${setup.reason}`,
      };
    }
  }

  return null;
}

/**
 * When sticky setup is NONE mid-swing but the closed 10s bar is a real Gold move,
 * enter CONTINUATION in the bar direction — do not sit out every V-leg as "NONE".
 * Still refuse tip-chase and refuse BUY into dump / SELL into rally.
 */
export function decideEntryFromTenSecMove(
  structure: StructureBook,
  bar: TenSecBar,
  minutes?: CapitalPriceCandle[] | null
): SetupEntry | null {
  if (!structure.ready) return null;
  const thr = PLAYBOOK_ENTRY_BODY.SCALP;
  const body = bodyPct(bar);
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const minSpan = minSwingSpan(bar.close);
  const span = Math.max(hi - lo, structure.span, minSpan);
  const eps = edgeEps(bar.close, span);
  const need = thr * 0.65;
  const flow = priceFlowBias(minutes);

  if (body >= need) {
    if (flow === 'DOWN' || structure.bias === 'BELOW') return null;
    if (bar.close >= hi - eps * 0.3 && bar.close <= hi + eps * 0.15) return null;
    if (isLateChaseOnLocalLeg('BUY', minutes, bar)) return null;
    if (isRejectOffHigh(minutes, hi, eps)) return null;
    return {
      direction: 'BUY',
      setup: 'CONTINUATION',
      playbook: 'SCALP',
      reason: `ENTRY · 2s MOVE BUY O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} · setup was NONE`,
    };
  }
  if (body <= -need) {
    if (flow === 'UP' || structure.bias === 'ABOVE') return null;
    if (bar.close <= lo + eps * 0.3 && bar.close >= lo - eps * 0.15) return null;
    if (isLateChaseOnLocalLeg('SELL', minutes, bar)) return null;
    if (isBounceOffLow(minutes, lo, eps)) return null;
    return {
      direction: 'SELL',
      setup: 'CONTINUATION',
      playbook: 'SCALP',
      reason: `ENTRY · 2s MOVE SELL O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} · setup was NONE`,
    };
  }
  return null;
}

export function playbookFromSetup(setup: MarketSetup | null | undefined): TradePlaybook | null {
  if (!setup || setup.kind === 'NONE') return null;
  return setup.playbook;
}

export function setupCatalog() {
  return SETUP_KINDS.map((k) => ({ name: k }));
}
