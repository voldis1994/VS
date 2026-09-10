/**
 * Setup-first market model (LIVE desk brain).
 *
 * Capital quote + 1m (+ 15m context) + 10s → STRUCTURE → SETUP → ENTRY → BEST OUTCOME
 *
 * Hard rules:
 * - Setup changes only on structure refresh / closed bars — never on every quote tick
 * - NONE = no tradeable setup (not a "WAIT regime")
 * - ARMED = setup ready; ENTRY only on closed Capital 1m candle that confirms the side
 * - Open trade freezes setup; manage = best outcome only
 * - Live mid / 10s never open a trade (diagnostics / optional extra only)
 */
import type { CapitalPriceCandle } from './capitalCom.js';
import type { TradePlaybook } from './playbooks.js';
import { PLAYBOOK_ENTRY_BODY, withTrendSideFromRegime } from './playbooks.js';
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
  /** Context TF bias from Capital 15m (field name legacy; was 1h) */
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

/** Edge band in price points — Gold-friendly floor */
function edgeEps(px: number, span: number): number {
  return Math.max(Math.abs(px) * 0.00035, span * 0.08, 0.8);
}

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

/** Bias from Capital 15m context candles (replaces slow 1h). */
function contextBiasFrom(bars: CapitalPriceCandle[] | null | undefined): StructureBook['hour_bias'] {
  if (!bars || bars.length < 3) return 'UNKNOWN';
  const last = bars.slice(-6);
  const bodies = last.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  const p = mean(bodies.map((v) => (v > 0.0002 ? 1 : v < -0.0002 ? -1 : 0)));
  if (p > 0.35) return 'UP';
  if (p < -0.35) return 'DOWN';
  return 'FLAT';
}

/**
 * Build durable structure from Capital minutes (+ optional 15m context).
 * Optional prevSwing keeps levels sticky across refreshes until clearly broken.
 */
export function buildStructure(input: {
  minutes: CapitalPriceCandle[];
  /** @deprecated use context15 — kept for callers */
  hours?: CapitalPriceCandle[] | null;
  /** Capital 15m candles for context bias */
  context15?: CapitalPriceCandle[] | null;
  mid?: number | null;
  prev?: StructureBook | null;
}): StructureBook {
  const { minutes, mid: lastMid, prev } = input;
  const context = input.context15 ?? input.hours;
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

  const hb = contextBiasFrom(context);

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
    detail: `swing H${hi.toFixed(2)} L${lo.toFixed(2)} · ${bias} · 15m ${hb} · 1m×${minutes.length}`,
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
      ? Math.max(Math.abs(first.open) * 0.00035, 1.2)
      : Math.max(Math.abs(first.open) * 0.0005, 1.8);
  const persThr = mode === 'flip' ? 0.4 : 0.35;
  if (pers <= -persThr && net <= -thr) return 'DOWN';
  if (pers >= persThr && net >= thr) return 'UP';

  // Sharp last 2 minutes same direction — live V-leg without waiting for longer net
  if (slice.length >= 2) {
    const a = slice[slice.length - 2]!;
    const b = last;
    const sharp = b.close - a.open;
    const sharpThr = Math.max(Math.abs(a.open) * 0.00045, 2.0);
    const bothDown = a.close <= a.open && b.close < b.open;
    const bothUp = a.close >= a.open && b.close > b.open;
    if (sharp <= -sharpThr && bothDown) return 'DOWN';
    if (sharp >= sharpThr && bothUp) return 'UP';
  }
  return null;
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
  const thr = Math.max(Math.abs(first.open) * 0.00035, 1.4);
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

  // ——— IMPULSE FIRST — flip candidate side, but FORMING (sticky must confirm before entry) ———
  if (imp === 'UP') {
    if (closedAbove || last.close >= hi - eps * 0.5) {
      return {
        kind: 'BREAKOUT',
        side: 'BUY',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE UP through H${hi.toFixed(2)} → BUY forming`,
      };
    }
    return {
      kind: 'CONTINUATION',
      side: 'BUY',
      playbook: 'LONG',
      status: 'FORMING',
      swing_high: hi,
      swing_low: lo,
      reason: `IMPULSE UP → BUY forming · mid ${structure.mid.toFixed(2)}`,
    };
  }
  if (imp === 'DOWN') {
    if (closedBelow || last.close <= lo + eps * 0.5) {
      return {
        kind: 'BREAKOUT',
        side: 'SELL',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE DOWN through L${lo.toFixed(2)} → SELL forming`,
      };
    }
    return {
      kind: 'CONTINUATION',
      side: 'SELL',
      playbook: 'LONG',
      status: 'FORMING',
      swing_high: hi,
      swing_low: lo,
      reason: `IMPULSE DOWN → SELL forming · mid ${structure.mid.toFixed(2)}`,
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
      playbook: 'LONG',
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
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT below ${lo.toFixed(2)} → SELL`,
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
    return {
      kind: 'CONTINUATION',
      side: 'BUY',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `Rally through high zone · BUY not FADE · H${hi.toFixed(2)}`,
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
    return {
      kind: 'CONTINUATION',
      side: 'SELL',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `Dump through low zone · SELL not FADE BUY · L${lo.toFixed(2)}`,
    };
  }

  // CONTINUATION / PULLBACK in trend (15m + minute persistence) — mid/pullback only
  const trendUp =
    pers > 0.35 || structure.hour_bias === 'UP' || structure.bias === 'ABOVE';
  const trendDown =
    pers < -0.35 || structure.hour_bias === 'DOWN' || structure.bias === 'BELOW';

  if (trendUp && !closedBelow && !structure.near_high) {
    if (last.close < structure.mid && last.close > lo) {
      return {
        kind: 'PULLBACK',
        side: 'BUY',
        playbook: 'SCALP',
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
        playbook: 'SCALP',
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
 * Sticky setup update — candidate may flip immediately; ARMED after sticky confirm.
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
    // PULLBACK may stay FORMING until structure upgrades; everything else arms after sticky confirm
    const status: SetupStatus =
      raw.kind === 'NONE'
        ? 'NONE'
        : confirm >= SETUP_CONFIRM
          ? raw.kind === 'PULLBACK' && raw.status === 'FORMING'
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

  // Impulse / breakout / continuation — start FORMING (no instant flip-entry)
  if (
    raw.side &&
    (String(raw.reason).includes('IMPULSE') ||
      raw.kind === 'BREAKOUT' ||
      raw.kind === 'CONTINUATION')
  ) {
    const flipped = Boolean(prevSafe.side && prevSafe.side !== raw.side);
    return withWatch({
      ...raw,
      status: 'FORMING',
      confirm: 1,
      reason: flipped ? `${raw.reason} · flipped from ${prevSafe.side}` : raw.reason,
      updated_at: now,
    });
  }

  // Leaving NONE — FORMING first tick; sticky confirm arms (no chase on first print)
  if (prevSafe.kind === 'NONE' && raw.kind !== 'NONE' && raw.side) {
    return withWatch({
      ...raw,
      status: 'FORMING',
      confirm: 1,
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
      status: raw.kind === 'NONE' ? 'NONE' : 'FORMING',
      confirm: raw.kind === 'NONE' ? 0 : 1,
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
/**
 * Tip-chase: do not buy the swing high / sell the swing low.
 * BREAKOUT always exempt. CONTINUATION exempt when close is clearly THROUGH the level.
 */
export function isTipChaseEntry(setup: MarketSetup, bar: TenSecBar): boolean {
  if (!setup.side || setup.kind === 'NONE' || setup.kind === 'BREAKOUT') {
    return false;
  }
  if (
    setup.kind !== 'FADE' &&
    setup.kind !== 'FAILED_BREAK' &&
    setup.kind !== 'PULLBACK' &&
    setup.kind !== 'CONTINUATION'
  ) {
    return false;
  }
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  if (!(hi > lo)) return false;
  // Through-level CONTINUATION is a real break — not tip-chase
  if (setup.kind === 'CONTINUATION') {
    if (setup.side === 'BUY' && bar.close > hi) return false;
    if (setup.side === 'SELL' && bar.close < lo) return false;
  }
  const eps = edgeEps(bar.close, hi - lo);
  const band = setup.kind === 'CONTINUATION' ? 0.45 : 0.35;
  if (setup.side === 'BUY' && bar.close >= hi - eps * band) return true;
  if (setup.side === 'SELL' && bar.close <= lo + eps * band) return true;
  return false;
}

/**
 * Optional EXTRA confirm on a closed 10s bar — desk does NOT open on this alone.
 * Live path uses decideEntryFromClosed1m (Capital 1m close).
 */
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

  if (isTipChaseEntry(setup, bar)) {
    return null;
  }

  if (setup.kind === 'FADE' || setup.kind === 'FAILED_BREAK') {
    if (setup.side === 'BUY') {
      const touched = bar.low <= lo + eps;
      // Only block if bar is clearly dumping through the floor
      const stillDumping = bar.close < bar.open && bar.low < lo - eps * 0.5;
      if (touched && !stillDumping && body >= thr * 0.85 && bar.close > bar.open) {
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
    if (touched && !stillRallying && body <= -thr * 0.85 && bar.close < bar.open) {
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
    if (setup.side === 'BUY' && body >= thr * 0.85 && bar.close > hi) {
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr * 0.85 && bar.close < lo) {
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
      body >= thr * 0.85 &&
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
      body <= -thr * 0.85 &&
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
    // Full body confirm — no ×0.55 looseners that chased every 10s blip
    if (setup.side === 'BUY' && body >= thr) {
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr) {
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

/** Map Capital 1m OHLC into the tip-chase probe shape (same open/high/low/close). */
export function capitalMinuteAsBar(c: CapitalPriceCandle): TenSecBar {
  return {
    open_time_ms: c.snapshot_time_ms ?? 0,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    ticks: 1,
  };
}

/** Only these setups may open — FADE/PULLBACK/RANGE noise is watch-only. */
export const QUALITY_ENTRY_KINDS = new Set<SetupKind>(['CONTINUATION', 'BREAKOUT']);
/** Capital 1m body floor in price points (Gold) — blips below this are noise */
export const QUALITY_1M_BODY_ABS = 2.5;

export function isQualityEntrySetup(kind: string | null | undefined): boolean {
  return QUALITY_ENTRY_KINDS.has(String(kind || '').toUpperCase() as SetupKind);
}

/**
 * PRIMARY live entry — sticky ARMED CONTINUATION/BREAKOUT + closed Capital 1m.
 * Quality gate: real 1m body, impulse agree, 15m context not against,
 * TREND_UP→BUY only / TREND_DOWN→SELL only. No FADE/PULLBACK spam.
 */
export function decideEntryFromClosed1m(
  setup: MarketSetup,
  closed1m: CapitalPriceCandle,
  minutes?: CapitalPriceCandle[] | null,
  structure?: StructureBook | null,
  regime?: string | null
): SetupEntry | null {
  if (
    setup.kind === 'NONE' ||
    setup.status !== 'ARMED' ||
    !setup.side ||
    !setup.playbook ||
    !Number.isFinite(closed1m.close) ||
    !Number.isFinite(closed1m.open)
  ) {
    return null;
  }

  // ——— QUALITY GATE: no junk / noise setups ———
  if (!isQualityEntrySetup(setup.kind)) return null;

  const bodyAbs = Math.abs(closed1m.close - closed1m.open);
  if (bodyAbs < QUALITY_1M_BODY_ABS) return null;

  // TREND_UP = BUY only; TREND_DOWN = SELL only (with-trend brain)
  const trendSide = withTrendSideFromRegime(regime);
  if (trendSide && setup.side !== trendSide) return null;

  // 15m context must not fight the side (UNKNOWN/FLAT OK; opposite bias = refuse)
  if (structure?.ready) {
    if (setup.side === 'BUY' && structure.hour_bias === 'DOWN') return null;
    if (setup.side === 'SELL' && structure.hour_bias === 'UP') return null;
  }

  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  // Need affirmative impulse with the side — quiet/NONE impulse = noise
  if (setup.side === 'BUY' && imp !== 'UP') return null;
  if (setup.side === 'SELL' && imp !== 'DOWN') return null;

  const book = setup.playbook;
  const thr = PLAYBOOK_ENTRY_BODY[book];
  const bar = capitalMinuteAsBar(closed1m);
  const body = bodyPct(bar);
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  if (!(hi > lo)) return null;
  const flow = priceFlowBias(minutes);

  // Hard: never BUY into a dump / SELL into a rally
  if (setup.side === 'BUY' && flow === 'DOWN') return null;
  if (setup.side === 'SELL' && flow === 'UP') return null;

  if (isTipChaseEntry(setup, bar)) return null;

  if (setup.kind === 'BREAKOUT') {
    // Through swing + quality body (already ≥ QUALITY_1M_BODY_ABS)
    if (setup.side === 'BUY' && body >= thr * 0.85 && bar.close > hi) {
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT BUY Capital 1m · body ${bodyAbs.toFixed(2)}pt · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr * 0.85 && bar.close < lo) {
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT SELL Capital 1m · body ${bodyAbs.toFixed(2)}pt · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'CONTINUATION') {
    if (setup.side === 'BUY' && body >= thr && bar.close > bar.open) {
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION BUY Capital 1m · body ${bodyAbs.toFixed(2)}pt · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr && bar.close < bar.open) {
      return {
        direction: 'SELL',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION SELL Capital 1m · body ${bodyAbs.toFixed(2)}pt · ${setup.reason}`,
      };
    }
  }

  return null;
}

/**
 * DISABLED on live desk — live mid chase caused LONG↔SHORT flip spam after HardInv.
 * Kept as null stub so callers/tests stay typed; use decideEntryFromClosed1m.
 */
export function decideEntryFromArmedLive(
  _setup: MarketSetup,
  _mid: number,
  _minutes?: CapitalPriceCandle[] | null
): SetupEntry | null {
  return null;
}

/**
 * DISABLED on live desk — mid-NONE 10s chase caused LONG↔SHORT flip spam.
 * Kept as null stub so callers/tests stay typed; real entries need ARMED setup.
 */
export function decideEntryFromTenSecMove(
  _structure: StructureBook,
  _bar: TenSecBar,
  _minutes?: CapitalPriceCandle[] | null
): SetupEntry | null {
  return null;
}

export function playbookFromSetup(setup: MarketSetup | null | undefined): TradePlaybook | null {
  if (!setup || setup.kind === 'NONE') return null;
  return setup.playbook;
}

export function setupCatalog() {
  return SETUP_KINDS.map((k) => ({ name: k }));
}
