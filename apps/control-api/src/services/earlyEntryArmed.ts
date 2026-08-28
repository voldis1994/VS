/**
 * Early ENTRY trigger — stateful SETUP → ARMED → TRIGGERED | INVALIDATED.
 *
 * HTF/5m locate WHERE/WHY (support/resistance). 10s/1m time the ENTRY.
 * Full 5m BOS/CHoCH is a strong/late confirmation path elsewhere — not required here.
 * Zone touch alone is NEVER entry. Chase past the zone is NEVER entry.
 */

import {
  analyzeMarketStructure,
  hasEvent,
  structuralStopLevel,
  type StructureBar,
  type Pivot,
} from './marketStructure.js';
import { buildScalpZone, type ScalpZone } from './zones.js';
import { atrWilder, moveThresholdPts } from './volatilityNorm.js';
import type { HtfContext } from './fiveMinuteBrain.js';
import { isRealBar } from './ohlcQuality.js';
import { oneMinMoveConfirm } from './oneMinMoveEntry.js';

export type ArmedPhase = 'IDLE' | 'SETUP' | 'ARMED' | 'TRIGGERED' | 'INVALIDATED';

export type ArmedTriggerState = {
  phase: ArmedPhase;
  direction: 'BUY' | 'SELL' | null;
  zone_low: number | null;
  zone_high: number | null;
  invalidation: number | null;
  armed_at_ms: number | null;
  touched: boolean;
  /** Accumulated micro confirmation (stateful — not a single-candle if) */
  micro_score: number;
  /** Distinct confirm kinds seen while ARMED */
  confirms: string[];
  last_bar_ms: number | null;
  detail: string;
};

export type EarlyEntrySignal = {
  direction: 'BUY' | 'SELL';
  setup: 'PULLBACK' | 'REVERSAL' | 'SWEEP_RECLAIM';
  reason: string;
  structural_sl: number | null;
  zone_low: number;
  zone_high: number;
  early: true;
};

export type EarlyEntryCtx = {
  now_ms: number;
  price: number;
  bars5m: StructureBar[];
  bars1m?: StructureBar[] | null;
  bars10s?: StructureBar[] | null;
  htf?: HtfContext | null;
  /** Live tape direction — blocks EARLY against the tape (no BUY into dump). */
  tape_dir?: 'BUY' | 'SELL' | null;
  /** Sticky/classified regime — blocks EARLY into TREND_DOWN etc. */
  regime?: string | null;
  spread?: number | null;
  tick_size?: number | null;
  broker_min_stop?: number | null;
};

const MICRO_SCORE_ENTRY = 2;
/** Max distance beyond zone far edge as fraction of zone width (plus ATR) before chase. */
const CHASE_ZONE_MULT = 0.75;
/** Shared with entryPlan UI — arming pad must match PRICE ABOVE/BELOW badge. */
export const ZONE_PAD_FRAC = 0.05;

export function idleArmedState(): ArmedTriggerState {
  return {
    phase: 'IDLE',
    direction: null,
    zone_low: null,
    zone_high: null,
    invalidation: null,
    armed_at_ms: null,
    touched: false,
    micro_score: 0,
    confirms: [],
    last_bar_ms: null,
    detail: 'IDLE',
  };
}

function realSeries(bars: StructureBar[] | null | undefined): StructureBar[] {
  return (bars ?? []).filter((b) => isRealBar(b) && !b.forming);
}

function zoneWidth(low: number, high: number): number {
  return Math.max(high - low, 1e-9);
}

function inBand(price: number, low: number, high: number, padFrac = ZONE_PAD_FRAC): boolean {
  const w = zoneWidth(low, high);
  return price >= low - w * padFrac && price <= high + w * padFrac;
}

function nearLow(price: number, low: number, high: number): boolean {
  const w = zoneWidth(low, high);
  return price <= low + w * 0.35 && price >= low - w * 0.2;
}

function nearHigh(price: number, low: number, high: number): boolean {
  const w = zoneWidth(low, high);
  return price >= high - w * 0.35 && price <= high + w * 0.2;
}

/** Hard block EARLY BUY into downtrend / EARLY SELL into uptrend. */
export function earlyDirectionBlockedByRegime(
  direction: 'BUY' | 'SELL',
  regime?: string | null,
  tapeDir?: 'BUY' | 'SELL' | null
): string | null {
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (direction === 'BUY') {
    if (
      r === 'TREND_DOWN' ||
      r === 'BREAKOUT_DOWN' ||
      r === 'PULLBACK_DOWNTREND' ||
      r === 'FAILED_BREAKOUT_UP'
    ) {
      return `EARLY BUY blocked · regime ${r}`;
    }
    if (tapeDir === 'SELL') return 'EARLY BUY blocked · tape SELL (dump)';
  } else {
    if (
      r === 'TREND_UP' ||
      r === 'BREAKOUT_UP' ||
      r === 'PULLBACK_UPTREND' ||
      r === 'FAILED_BREAKOUT_DOWN'
    ) {
      return `EARLY SELL blocked · regime ${r}`;
    }
    if (tapeDir === 'BUY') return 'EARLY SELL blocked · tape BUY (rally)';
  }
  return null;
}

type LocatedZone = {
  direction: 'BUY' | 'SELL';
  low: number;
  high: number;
  invalidation: number;
  detail: string;
  setupBias: 'PULLBACK' | 'REVERSAL';
};

/**
 * HTF/5m locate a valid support (BUY) or resistance (SELL) zone — no BOS required.
 */
export function locateEarlyZone(ctx: EarlyEntryCtx): LocatedZone | null {
  const bars5m = realSeries(ctx.bars5m);
  if (bars5m.length < 8) return null;
  const ms = analyzeMarketStructure(bars5m);
  const atr = ms.atr ?? atrWilder(bars5m, 14);
  const buf =
    moveThresholdPts(ctx.price, atr, 0.15, 0.0002) ??
    (atr != null && atr > 0 ? atr * 0.15 : null);
  if (buf == null) return null;

  const zoneSrc = realSeries(ctx.bars10s).length
    ? realSeries(ctx.bars10s)
    : realSeries(ctx.bars1m);
  const zone: ScalpZone | null = buildScalpZone(
    zoneSrc.map((b) => ({
      open_time_ms: b.open_time_ms,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ticks: b.ticks ?? 1,
      provenance: b.provenance ?? 'REAL',
    }))
  );

  const htf = ctx.htf;
  const htfOk = htf != null && htf.trend != null;
  const htfDown = htfOk && htf!.trend === 'DOWN';
  const htfUp = htfOk && htf!.trend === 'UP';
  const regimeBlockBuy = earlyDirectionBlockedByRegime('BUY', ctx.regime, ctx.tape_dir);
  const regimeBlockSell = earlyDirectionBlockedByRegime('SELL', ctx.regime, ctx.tape_dir);

  // BUY support — never locate BUY into HTF DOWN / tape dump / down regime
  const supportPivot = ms.last_swing_low;
  const buyLoc =
    !regimeBlockBuy &&
    !htfDown &&
    ms.trend !== 'DOWN' &&
    ((htfOk && (htf!.near_support || htf!.trend === 'UP')) ||
      ms.trend === 'UP' ||
      zone?.kind === 'DEMAND' ||
      hasEvent(ms, 'SWEEP', 'BULL') != null);

  if (buyLoc && supportPivot) {
    const low = Math.min(
      supportPivot.price,
      zone?.kind === 'DEMAND' ? zone.low : supportPivot.price
    );
    const high =
      zone?.kind === 'DEMAND'
        ? zone.high
        : Math.min(
            supportPivot.price + Math.max(buf * 4, (atr ?? buf) * 0.8),
            ms.last_swing_high?.price ?? supportPivot.price + buf * 8
          );
    if (high > low) {
      return {
        direction: 'BUY',
        low,
        high,
        invalidation: low - buf,
        detail: `support ${low.toFixed(4)}–${high.toFixed(4)} · 5m ${ms.trend} · HTF ${htf?.trend ?? '?'}`,
        setupBias: hasEvent(ms, 'SWEEP', 'BULL') ? 'REVERSAL' : 'PULLBACK',
      };
    }
  }

  // SELL resistance — never locate SELL into HTF UP / tape rally / up regime
  const resistPivot = ms.last_swing_high;
  const sellLoc =
    !regimeBlockSell &&
    !htfUp &&
    ms.trend !== 'UP' &&
    ((htfOk && (htf!.near_resistance || htf!.trend === 'DOWN')) ||
      ms.trend === 'DOWN' ||
      zone?.kind === 'SUPPLY' ||
      hasEvent(ms, 'SWEEP', 'BEAR') != null);

  if (sellLoc && resistPivot) {
    const high = Math.max(
      resistPivot.price,
      zone?.kind === 'SUPPLY' ? zone.high : resistPivot.price
    );
    const low =
      zone?.kind === 'SUPPLY'
        ? zone.low
        : Math.max(
            resistPivot.price - Math.max(buf * 4, (atr ?? buf) * 0.8),
            ms.last_swing_low?.price ?? resistPivot.price - buf * 8
          );
    if (high > low) {
      return {
        direction: 'SELL',
        low,
        high,
        invalidation: high + buf,
        detail: `resistance ${low.toFixed(4)}–${high.toFixed(4)} · 5m ${ms.trend} · HTF ${htf?.trend ?? '?'}`,
        setupBias: ms.trend === 'UP' || hasEvent(ms, 'SWEEP', 'BEAR') ? 'REVERSAL' : 'PULLBACK',
      };
    }
  }

  return null;
}

function addConfirm(state: ArmedTriggerState, kind: string, pts: number): void {
  if (state.confirms.includes(kind)) return;
  state.confirms = [...state.confirms, kind];
  state.micro_score += pts;
}

/**
 * Stateful micro confirmation on 10s/1m while ARMED.
 * Touch alone must not push score to entry.
 */
export function scoreMicroConfirmation(
  state: ArmedTriggerState,
  ctx: EarlyEntryCtx
): { score: number; kinds: string[]; detail: string } {
  if (state.direction == null || state.zone_low == null || state.zone_high == null) {
    return { score: 0, kinds: [], detail: 'no zone' };
  }
  const dir = state.direction;
  const low = state.zone_low;
  const high = state.zone_high;
  const bars10 = realSeries(ctx.bars10s);
  const bars1m = realSeries(ctx.bars1m);
  // Prefer native 10s; when OFF / empty, score on Capital 1m so EARLY can still fire.
  const ltf = bars10.length >= 1 ? bars10 : bars1m;
  const last10 = ltf[ltf.length - 1];
  const prev10 = ltf[ltf.length - 2];
  if (!last10) {
    return {
      score: state.micro_score,
      kinds: state.confirms,
      detail: bars10.length ? 'no 10s' : 'no 1m LTF',
    };
  }

  const next: ArmedTriggerState = {
    ...state,
    confirms: [...state.confirms],
    micro_score: state.micro_score,
  };

  const range = Math.max(last10.high - last10.low, 1e-9);
  const body = Math.abs(last10.close - last10.open);
  const lowerWick = Math.min(last10.open, last10.close) - last10.low;
  const upperWick = last10.high - Math.max(last10.open, last10.close);

  // Closed 1m MOVE — strong single confirm when 10s OFF (full +2 toward entry)
  if (bars1m.length >= 1) {
    const move = oneMinMoveConfirm(
      bars1m,
      dir,
      ctx.price,
      atrWilder(realSeries(ctx.bars5m), 14),
      { tick_size: ctx.tick_size },
      { allowLive: true }
    );
    if (move.ok) {
      addConfirm(next, '1m_move', 2);
    }
  }

  if (dir === 'BUY') {
    // Sweep → reclaim of support
    if (last10.low < low && last10.close > low) {
      addConfirm(next, 'sweep_reclaim', 2);
    }
    // Rejection wick at support (need real green body — doji touch ≠ confirm)
    if (
      nearLow(last10.low, low, high) &&
      body > 0 &&
      last10.close > last10.open &&
      lowerWick >= body * 1.2 &&
      lowerWick >= range * 0.35
    ) {
      addConfirm(next, 'rejection', 2);
    }
    // Reclaim after dip below mid
    if (prev10 && prev10.close <= (low + high) / 2 && last10.close > (low + high) / 2 && last10.close > last10.open) {
      addConfirm(next, 'reclaim', 2);
    }
    // Sell impulse weakening: recent 1m net down, now green displacement
    if (bars1m.length >= 3) {
      const a = bars1m[bars1m.length - 3]!;
      const b = bars1m[bars1m.length - 1]!;
      const net = b.close - a.open;
      if (net < 0 && last10.close > last10.open && last10.close > low) {
        addConfirm(next, 'impulse_fade', 1);
      }
    }
    // Micro structure shift on 1m or LTF (not 5m BOS)
    const microBars = bars1m.length >= 6 ? bars1m : ltf.slice(-30);
    if (microBars.length >= 6) {
      const ms = analyzeMarketStructure(microBars, { pivotLeft: 1, pivotRight: 1 });
      if (
        hasEvent(ms, 'RECLAIM', 'BULL') ||
        hasEvent(ms, 'DISPLACEMENT', 'BULL') ||
        hasEvent(ms, 'CHOCH', 'BULL')
      ) {
        addConfirm(next, 'micro_shift', 2);
      }
    }
  } else {
    if (last10.high > high && last10.close < high) {
      addConfirm(next, 'sweep_reclaim', 2);
    }
    if (
      nearHigh(last10.high, low, high) &&
      body > 0 &&
      last10.close < last10.open &&
      upperWick >= body * 1.2 &&
      upperWick >= range * 0.35
    ) {
      addConfirm(next, 'rejection', 2);
    }
    if (prev10 && prev10.close >= (low + high) / 2 && last10.close < (low + high) / 2 && last10.close < last10.open) {
      addConfirm(next, 'reclaim', 2);
    }
    if (bars1m.length >= 3) {
      const a = bars1m[bars1m.length - 3]!;
      const b = bars1m[bars1m.length - 1]!;
      const net = b.close - a.open;
      if (net > 0 && last10.close < last10.open && last10.close < high) {
        addConfirm(next, 'impulse_fade', 1);
      }
    }
    const microBars = bars1m.length >= 6 ? bars1m : ltf.slice(-30);
    if (microBars.length >= 6) {
      const ms = analyzeMarketStructure(microBars, { pivotLeft: 1, pivotRight: 1 });
      if (
        hasEvent(ms, 'RECLAIM', 'BEAR') ||
        hasEvent(ms, 'DISPLACEMENT', 'BEAR') ||
        hasEvent(ms, 'CHOCH', 'BEAR')
      ) {
        addConfirm(next, 'micro_shift', 2);
      }
    }
  }

  // Persist score/kinds onto caller state via return; advance applies them.
  return {
    score: next.micro_score,
    kinds: next.confirms,
    detail: next.confirms.length
      ? `micro ${next.confirms.join('+')} · score ${next.micro_score}`
      : 'micro pending · touch≠entry',
  };
}

export function isChasedFromZone(
  direction: 'BUY' | 'SELL',
  price: number,
  low: number,
  high: number,
  atr: number | null
): boolean {
  const w = zoneWidth(low, high);
  const pad = Math.max(w * CHASE_ZONE_MULT, atr != null && atr > 0 ? atr * 0.35 : w * 0.5);
  if (direction === 'BUY') return price > high + pad;
  return price < low - pad;
}

function structuralSlForZone(
  direction: 'BUY' | 'SELL',
  low: number,
  high: number,
  ctx: EarlyEntryCtx,
  atr: number | null
): number | null {
  const pivot: Pivot =
    direction === 'BUY'
      ? { index: 0, price: low, time_ms: ctx.now_ms, kind: 'LOW' }
      : { index: 0, price: high, time_ms: ctx.now_ms, kind: 'HIGH' };
  return structuralStopLevel(direction, pivot, {
    atr,
    spread: ctx.spread,
    brokerMinStop: ctx.broker_min_stop,
    price: ctx.price,
    tickSize: ctx.tick_size,
  });
}

export type EarlyAdvanceResult = {
  state: ArmedTriggerState;
  signal: EarlyEntrySignal | null;
};

/**
 * Advance SETUP → ARMED → TRIGGERED → ENTRY, or → INVALIDATED.
 * Idempotent per bar_ms; stateful across ticks.
 */
export function advanceEarlyEntryArmed(
  prev: ArmedTriggerState | null | undefined,
  ctx: EarlyEntryCtx
): EarlyAdvanceResult {
  let state: ArmedTriggerState = prev ? { ...prev, confirms: [...prev.confirms] } : idleArmedState();
  const bars5m = realSeries(ctx.bars5m);
  const atr = atrWilder(bars5m, 14) ?? analyzeMarketStructure(bars5m).atr;
  const bars10 = realSeries(ctx.bars10s);
  const bars1mLtf = realSeries(ctx.bars1m);
  const ltf = bars10.length >= 1 ? bars10 : bars1mLtf;
  const last10 = ltf[ltf.length - 1];
  const barMs = last10?.open_time_ms ?? null;

  // Same bar — do not double-count micro confirms
  const newBar = barMs != null && barMs !== state.last_bar_ms;

  const located = locateEarlyZone(ctx);
  if (!located) {
    if (state.phase === 'ARMED' || state.phase === 'SETUP') {
      return {
        state: {
          ...idleArmedState(),
          phase: 'INVALIDATED',
          detail: 'zone lost · HTF/5m location gone',
        },
        signal: null,
      };
    }
    return { state: idleArmedState(), signal: null };
  }

  // Kill armed side if regime/tape flipped against it mid-setup
  const against = earlyDirectionBlockedByRegime(
    located.direction,
    ctx.regime,
    ctx.tape_dir
  );
  if (against) {
    return {
      state: {
        ...idleArmedState(),
        phase: 'INVALIDATED',
        detail: against,
      },
      signal: null,
    };
  }

  // Fresh SETUP when idle / after invalidate / direction flip
  if (
    state.phase === 'IDLE' ||
    state.phase === 'INVALIDATED' ||
    state.phase === 'TRIGGERED' ||
    (state.direction != null && state.direction !== located.direction)
  ) {
    state = {
      phase: 'SETUP',
      direction: located.direction,
      zone_low: located.low,
      zone_high: located.high,
      invalidation: located.invalidation,
      armed_at_ms: null,
      touched: false,
      micro_score: 0,
      confirms: [],
      last_bar_ms: barMs,
      detail: `SETUP · ${located.detail}`,
    };
  } else {
    // Refresh zone geometry while keeping score if same direction
    state.zone_low = located.low;
    state.zone_high = located.high;
    state.invalidation = located.invalidation;
    state.direction = located.direction;
  }

  const low = state.zone_low!;
  const high = state.zone_high!;
  const inv = state.invalidation!;
  const dir = state.direction!;
  const price = ctx.price;

  // Invalidation — real break of support/resistance
  if (dir === 'BUY' && price < inv) {
    return {
      state: {
        ...idleArmedState(),
        phase: 'INVALIDATED',
        direction: 'BUY',
        zone_low: low,
        zone_high: high,
        invalidation: inv,
        detail: `INVALIDATED BUY · price ${price.toFixed(4)} < inv ${inv.toFixed(4)}`,
      },
      signal: null,
    };
  }
  if (dir === 'SELL' && price > inv) {
    return {
      state: {
        ...idleArmedState(),
        phase: 'INVALIDATED',
        direction: 'SELL',
        zone_low: low,
        zone_high: high,
        invalidation: inv,
        detail: `INVALIDATED SELL · price ${price.toFixed(4)} > inv ${inv.toFixed(4)}`,
      },
      signal: null,
    };
  }

  // Chase — too far from zone already
  if (isChasedFromZone(dir, price, low, high, atr)) {
    return {
      state: {
        ...state,
        phase: 'SETUP',
        touched: false,
        micro_score: 0,
        confirms: [],
        detail: `NO ENTRY · chased off zone · ${dir} px=${price.toFixed(4)} vs ${low.toFixed(4)}–${high.toFixed(4)}`,
      },
      signal: null,
    };
  }

  const interacting =
    inBand(price, low, high) ||
    (dir === 'BUY' && nearLow(price, low, high)) ||
    (dir === 'SELL' && nearHigh(price, low, high)) ||
    (last10 != null &&
      ((dir === 'BUY' && last10.low <= high && last10.high >= low) ||
        (dir === 'SELL' && last10.high >= low && last10.low <= high)));

  if (!interacting) {
    state.phase = 'SETUP';
    state.detail = `SETUP · waiting price in zone · ${located.detail}`;
    state.last_bar_ms = barMs;
    return { state, signal: null };
  }

  // Price in/near zone → ARMED (touch recorded, not entry)
  if (state.phase === 'SETUP' || state.phase === 'ARMED') {
    state.phase = 'ARMED';
    state.armed_at_ms = state.armed_at_ms ?? ctx.now_ms;
    state.touched = true;
  }

  if (newBar || state.micro_score === 0) {
    const micro = scoreMicroConfirmation(state, ctx);
    state.micro_score = micro.score;
    state.confirms = micro.kinds;
    state.detail = `ARMED · ${located.detail} · ${micro.detail}`;
  } else {
    state.detail = `ARMED · ${located.detail} · score ${state.micro_score}`;
  }
  state.last_bar_ms = barMs;

  // Touch-only: armed but score below threshold → NO ENTRY
  if (state.micro_score < MICRO_SCORE_ENTRY) {
    return { state, signal: null };
  }

  const sl = structuralSlForZone(dir, low, high, ctx, atr);
  if (sl == null) {
    state.detail = `ARMED · micro ok · structural SL UNKNOWN · NO ENTRY`;
    return { state, signal: null };
  }

  const setup: EarlyEntrySignal['setup'] =
    state.confirms.includes('sweep_reclaim') ? 'SWEEP_RECLAIM' : located.setupBias;

  state.phase = 'TRIGGERED';
  state.detail = `TRIGGERED · ${setup} ${dir} · ${state.confirms.join('+')} · score ${state.micro_score}`;

  return {
    state,
    signal: {
      direction: dir,
      setup,
      reason: `EARLY ${state.detail}`,
      structural_sl: sl,
      zone_low: low,
      zone_high: high,
      early: true,
    },
  };
}
