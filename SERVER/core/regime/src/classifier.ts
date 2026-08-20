/**
 * Full regime set — confidence + evidence. Never places orders.
 * RANGE requires proven evidence — Donchian alone is NOT enough.
 * applyHysteresis is used on the live classify path.
 */

export type RegimeId =
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'RANGE'
  | 'BREAKOUT_UP_CANDIDATE'
  | 'BREAKOUT_UP_CONFIRMED'
  | 'BREAKOUT_UP_FAILED'
  | 'BREAKOUT_DOWN_CANDIDATE'
  | 'BREAKOUT_DOWN_CONFIRMED'
  | 'BREAKOUT_DOWN_FAILED'
  | 'VOLATILITY_EXPANSION'
  | 'VOLATILITY_COMPRESSION'
  | 'REVERSAL_BULLISH_CANDIDATE'
  | 'REVERSAL_BEARISH_CANDIDATE'
  | 'LIQUIDITY_RISK'
  | 'ABNORMAL_SPREAD'
  | 'STALE_MARKET'
  | 'UNSTABLE_MARKET'
  | 'TRANSITION'
  | 'NO_TRADE';

export type InternalStructure = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type RegimeResult = {
  regime: RegimeId;
  confidence: number;
  evidence: string[];
  invalidations: string[];
  no_trade_reasons?: string[];
  rangeHigh?: number;
  rangeLow?: number;
  rangeMid?: number;
  rangeWidth?: number;
  internal_structure?: InternalStructure;
  rangeWidthAtr?: number;
  midpointSlope?: number;
  directionalDisplacement?: number;
  rangeEfficiency?: number;
  edgeTouches?: number;
  midpointCrossings?: number;
};

export type RegimeInput = {
  closes: number[];
  highs: number[];
  lows: number[];
  atr: number | null;
  atrBaseline: number | null;
  spread: number | null;
  maxSpread: number | null;
  quoteAgeMs: number | null;
  maxQuoteAgeMs: number;
  marketAvailable: boolean;
  brokerConnected: boolean;
  reconciliationPending: boolean;
  riskLimitHit: boolean;
  killSwitch: boolean;
  resistance?: number | null;
  support?: number | null;
};

import { ema, slope, donchian, rsi, momentum } from '../../indicators/src/index.js';

export function classifyNoTrade(input: RegimeInput): RegimeResult | null {
  const reasons: string[] = [];
  if (!input.marketAvailable) reasons.push('MARKET_OFFLINE');
  if (input.quoteAgeMs != null && input.quoteAgeMs > input.maxQuoteAgeMs) {
    reasons.push('MARKET_STALE');
  }
  if (
    input.spread != null &&
    input.maxSpread != null &&
    input.spread > input.maxSpread
  ) {
    reasons.push('SPREAD_TOO_HIGH');
  }
  if (!input.brokerConnected) reasons.push('BROKER_OFFLINE');
  if (input.reconciliationPending) reasons.push('RECONCILIATION_PENDING');
  if (input.riskLimitHit) reasons.push('RISK_BLOCKED');
  if (input.killSwitch) reasons.push('KILL_SWITCH');
  if (!reasons.length) return null;
  return {
    regime: 'NO_TRADE',
    confidence: 1,
    evidence: reasons,
    invalidations: [],
    no_trade_reasons: reasons,
  };
}

export function classifyAbnormalSpread(input: RegimeInput): RegimeResult | null {
  if (input.spread == null || input.maxSpread == null) return null;
  if (input.spread <= input.maxSpread) return null;
  return {
    regime: 'ABNORMAL_SPREAD',
    confidence: 1,
    evidence: [`SPREAD=${input.spread}`, `MAX=${input.maxSpread}`],
    invalidations: [],
    no_trade_reasons: ['SPREAD_TOO_HIGH'],
  };
}

export function classifyStale(input: RegimeInput): RegimeResult | null {
  if (input.quoteAgeMs == null) return null;
  if (input.quoteAgeMs <= input.maxQuoteAgeMs) return null;
  return {
    regime: 'STALE_MARKET',
    confidence: 1,
    evidence: [`QUOTE_AGE_MS=${input.quoteAgeMs}`],
    invalidations: [],
    no_trade_reasons: ['MARKET_STALE'],
  };
}

/** Swing structure from highs/lows series. */
export function detectInternalStructureFromSeries(
  highs: number[],
  lows: number[]
): InternalStructure {
  if (highs.length < 4 || lows.length < 4) return 'NEUTRAL';
  let hh = 0;
  let lh = 0;
  let hl = 0;
  let ll = 0;
  // Compare every other point as crude swing pairs
  for (let i = 2; i < highs.length; i += 1) {
    if (highs[i]! > highs[i - 2]!) hh += 1;
    else if (highs[i]! < highs[i - 2]!) lh += 1;
    if (lows[i]! > lows[i - 2]!) hl += 1;
    else if (lows[i]! < lows[i - 2]!) ll += 1;
  }
  if (hh >= lh && hl >= ll && hh + hl > lh + ll && hh + hl >= 2) return 'BULLISH';
  if (lh >= hh && ll >= hl && lh + ll > hh + hl && lh + ll >= 2) return 'BEARISH';
  return 'NEUTRAL';
}

export function classifyTrend(input: RegimeInput): RegimeResult {
  const { closes, highs, lows } = input;
  const structure = detectInternalStructureFromSeries(highs, lows);
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  const sl = slope(closes, 10);
  const atr = input.atr != null && input.atr > 0 ? input.atr : null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  const disp =
    first != null && last != null && atr
      ? Math.abs(last - first) / atr
      : first != null && last != null
        ? Math.abs(last - first) / Math.max(Math.abs(first), 1e-9)
        : 0;

  // Strong LH/LL or HH/HL with displacement beats weak EMA confidence
  if (structure === 'BEARISH' && disp >= 1.0) {
    return {
      regime: 'TREND_DOWN',
      confidence: Math.min(1, 0.55 + Math.min(0.35, disp * 0.1)),
      evidence: ['LH_LL_STRUCTURE', `DISP=${disp.toFixed(2)}`],
      invalidations: [],
      internal_structure: structure,
    };
  }
  if (structure === 'BULLISH' && disp >= 1.0) {
    return {
      regime: 'TREND_UP',
      confidence: Math.min(1, 0.55 + Math.min(0.35, disp * 0.1)),
      evidence: ['HH_HL_STRUCTURE', `DISP=${disp.toFixed(2)}`],
      invalidations: [],
      internal_structure: structure,
    };
  }

  if (fast == null || slow == null || sl == null) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      evidence: ['INSUFFICIENT_SERIES'],
      invalidations: [],
      no_trade_reasons: ['NO_CONFIDENCE'],
      internal_structure: structure,
    };
  }
  if (fast > slow && sl > 0) {
    return {
      regime: 'TREND_UP',
      confidence: Math.min(1, 0.45 + Math.min(0.4, Math.abs(sl) * 50)),
      evidence: ['FAST_EMA_ABOVE_SLOW', 'POSITIVE_SLOPE'],
      invalidations: [],
      internal_structure: structure,
    };
  }
  if (fast < slow && sl < 0) {
    return {
      regime: 'TREND_DOWN',
      confidence: Math.min(1, 0.45 + Math.min(0.4, Math.abs(sl) * 50)),
      evidence: ['FAST_EMA_BELOW_SLOW', 'NEGATIVE_SLOPE'],
      invalidations: [],
      internal_structure: structure,
    };
  }
  // Mixed EMA is NOT automatic RANGE — TRANSITION / structure only
  return {
    regime: 'TRANSITION',
    confidence: 0.35,
    evidence: ['MIXED_EMA_SLOPE', `STRUCT=${structure}`],
    invalidations: ['NO_CLEAR_TREND'],
    internal_structure: structure,
  };
}

/**
 * RANGE only with evidence: horizontal center, edge touches, midpoint crossings,
 * low directional efficiency, no dominant HH/HL or LH/LL, sane width/ATR.
 * Donchian(20) alone is NOT proof of RANGE.
 */
export function classifyRange(input: RegimeInput): RegimeResult {
  const d = donchian(input.highs, input.lows, 20);
  const structure = detectInternalStructureFromSeries(input.highs, input.lows);
  if (!d) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      evidence: ['INSUFFICIENT_SERIES'],
      invalidations: [],
      no_trade_reasons: ['NO_CONFIDENCE'],
      internal_structure: structure,
    };
  }

  const atr =
    input.atr != null && input.atr > 0
      ? input.atr
      : Math.max(d.high - d.low, 1e-9) / 4;
  const width = d.high - d.low;
  const widthAtr = width / atr;
  const closes = input.closes;
  const n = closes.length;
  const half = Math.max(3, Math.floor(n / 2));
  const early = closes.slice(0, half);
  const late = closes.slice(-half);
  const midEarly = early.length ? early.reduce((a, b) => a + b, 0) / early.length : d.mid;
  const midLate = late.length ? late.reduce((a, b) => a + b, 0) / late.length : d.mid;
  const midpointSlope = (midLate - midEarly) / atr;
  const first = closes[0] ?? d.mid;
  const last = closes[closes.length - 1] ?? d.mid;
  const directionalDisplacement = Math.abs(last - first) / atr;
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i]! - closes[i - 1]!);
  const dirEff = path > 1e-12 ? Math.abs(last - first) / path : 1;
  const rangeEfficiency = Math.max(0, Math.min(1, 1 - dirEff));
  const band = width * 0.12;
  let edgeTouches = 0;
  let midpointCrossings = 0;
  let prevSide = 0;
  for (let i = 0; i < input.highs.length; i++) {
    const h = input.highs[i]!;
    const l = input.lows[i]!;
    const c = input.closes[i] ?? (h + l) / 2;
    if (h >= d.high - band) edgeTouches += 1;
    if (l <= d.low + band) edgeTouches += 1;
    const side = c >= d.mid ? 1 : -1;
    if (prevSide && side !== prevSide) midpointCrossings += 1;
    prevSide = side;
  }

  const horizontal = Math.abs(midpointSlope) < 0.35;
  const widthOk = widthAtr >= 0.8 && widthAtr <= 8;

  const evidence: string[] = [
    `RANGE_HIGH=${d.high}`,
    `RANGE_LOW=${d.low}`,
    `WIDTH_ATR=${widthAtr.toFixed(2)}`,
    `MID_SLOPE=${midpointSlope.toFixed(2)}`,
    `DISP=${directionalDisplacement.toFixed(2)}`,
    `EFF=${rangeEfficiency.toFixed(2)}`,
    `EDGE=${edgeTouches}`,
    `MID_X=${midpointCrossings}`,
    `STRUCT=${structure}`,
  ];

  const provenRange =
    horizontal &&
    widthOk &&
    rangeEfficiency >= 0.4 &&
    midpointCrossings >= 2 &&
    edgeTouches >= 2 &&
    directionalDisplacement < 1.6 &&
    !(structure === 'BEARISH' && directionalDisplacement >= 0.9) &&
    !(structure === 'BULLISH' && directionalDisplacement >= 0.9);

  if (!provenRange) {
    evidence.push('RANGE_NOT_PROVEN');
    // Prefer structure trend over fake RANGE
    if (structure === 'BEARISH' && directionalDisplacement >= 0.9) {
      return {
        regime: 'TREND_DOWN',
        confidence: 0.6,
        evidence: [...evidence, 'LH_LL_NOT_RANGE'],
        invalidations: ['DONCHIAN_NOT_EVIDENCE'],
        internal_structure: structure,
        rangeHigh: d.high,
        rangeLow: d.low,
        rangeMid: d.mid,
        rangeWidth: width,
        rangeWidthAtr: widthAtr,
        midpointSlope,
        directionalDisplacement,
        rangeEfficiency,
        edgeTouches,
        midpointCrossings,
      };
    }
    if (structure === 'BULLISH' && directionalDisplacement >= 0.9) {
      return {
        regime: 'TREND_UP',
        confidence: 0.6,
        evidence: [...evidence, 'HH_HL_NOT_RANGE'],
        invalidations: ['DONCHIAN_NOT_EVIDENCE'],
        internal_structure: structure,
        rangeHigh: d.high,
        rangeLow: d.low,
        rangeMid: d.mid,
        rangeWidth: width,
        rangeWidthAtr: widthAtr,
        midpointSlope,
        directionalDisplacement,
        rangeEfficiency,
        edgeTouches,
        midpointCrossings,
      };
    }
    return {
      regime: 'TRANSITION',
      confidence: 0.35,
      evidence,
      invalidations: ['RANGE_NOT_PROVEN'],
      internal_structure: structure,
      rangeHigh: d.high,
      rangeLow: d.low,
      rangeMid: d.mid,
      rangeWidth: width,
      rangeWidthAtr: widthAtr,
      midpointSlope,
      directionalDisplacement,
      rangeEfficiency,
      edgeTouches,
      midpointCrossings,
    };
  }

  return {
    regime: 'RANGE',
    confidence: 0.65,
    evidence: [...evidence, 'RANGE_PROVEN'],
    invalidations: [],
    rangeHigh: d.high,
    rangeLow: d.low,
    rangeMid: d.mid,
    rangeWidth: width,
    internal_structure: structure,
    rangeWidthAtr: widthAtr,
    midpointSlope,
    directionalDisplacement,
    rangeEfficiency,
    edgeTouches,
    midpointCrossings,
  };
}

export function classifyBreakout(input: RegimeInput): RegimeResult | null {
  const last = input.closes[input.closes.length - 1];
  if (last == null) return null;
  const res = input.resistance;
  const sup = input.support;
  const d = donchian(input.highs, input.lows, 20);
  const resistance = res ?? d?.high ?? null;
  const support = sup ?? d?.low ?? null;
  if (resistance != null && last > resistance) {
    const atrOk = input.atr != null && input.atrBaseline != null && input.atr >= input.atrBaseline;
    if (atrOk) {
      return {
        regime: 'BREAKOUT_UP_CONFIRMED',
        confidence: 0.7,
        evidence: [`CLOSE_ABOVE_RESISTANCE=${resistance}`, 'ATR_EXPANSION'],
        invalidations: [],
      };
    }
    return {
      regime: 'BREAKOUT_UP_CANDIDATE',
      confidence: 0.5,
      evidence: [`CLOSE_ABOVE_RESISTANCE=${resistance}`],
      invalidations: ['AWAITING_VOL_CONFIRM'],
    };
  }
  if (support != null && last < support) {
    const atrOk = input.atr != null && input.atrBaseline != null && input.atr >= input.atrBaseline;
    if (atrOk) {
      return {
        regime: 'BREAKOUT_DOWN_CONFIRMED',
        confidence: 0.7,
        evidence: [`CLOSE_BELOW_SUPPORT=${support}`, 'ATR_EXPANSION'],
        invalidations: [],
      };
    }
    return {
      regime: 'BREAKOUT_DOWN_CANDIDATE',
      confidence: 0.5,
      evidence: [`CLOSE_BELOW_SUPPORT=${support}`],
      invalidations: ['AWAITING_VOL_CONFIRM'],
    };
  }
  return null;
}

export function classifyVolatility(input: RegimeInput): RegimeResult | null {
  if (input.atr == null || input.atrBaseline == null || input.atrBaseline <= 0) return null;
  const ratio = input.atr / input.atrBaseline;
  if (ratio >= 1.4) {
    return {
      regime: 'VOLATILITY_EXPANSION',
      confidence: Math.min(1, (ratio - 1) / 2),
      evidence: [`ATR_RATIO=${ratio.toFixed(3)}`],
      invalidations: [],
    };
  }
  if (ratio <= 0.7) {
    return {
      regime: 'VOLATILITY_COMPRESSION',
      confidence: Math.min(1, (1 - ratio) / 0.7),
      evidence: [`ATR_RATIO=${ratio.toFixed(3)}`],
      invalidations: [],
    };
  }
  return null;
}

export function classifyReversal(input: RegimeInput): RegimeResult | null {
  const r = rsi(input.closes, 14);
  const mom = momentum(input.closes, 5);
  if (r == null || mom == null) return null;
  if (r < 30 && mom > 0) {
    return {
      regime: 'REVERSAL_BULLISH_CANDIDATE',
      confidence: 0.45,
      evidence: [`RSI=${r.toFixed(2)}`, 'MOMENTUM_TURN_UP'],
      invalidations: ['CANDIDATE_NOT_CONFIRMED'],
    };
  }
  if (r > 70 && mom < 0) {
    return {
      regime: 'REVERSAL_BEARISH_CANDIDATE',
      confidence: 0.45,
      evidence: [`RSI=${r.toFixed(2)}`, 'MOMENTUM_TURN_DOWN'],
      invalidations: ['CANDIDATE_NOT_CONFIRMED'],
    };
  }
  return null;
}

/** Raw classification without hysteresis dwell. */
export function classifyRegimeRaw(input: RegimeInput): RegimeResult {
  const blocked = classifyNoTrade(input);
  if (blocked) return blocked;
  const stale = classifyStale(input);
  if (stale) return stale;
  const spread = classifyAbnormalSpread(input);
  if (spread) return spread;

  const brk = classifyBreakout(input);
  if (brk && brk.confidence >= 0.65) return brk;

  const vol = classifyVolatility(input);
  if (vol && vol.confidence > 0.75) return vol;

  const trend = classifyTrend(input);
  if (trend.regime === 'TREND_UP' || trend.regime === 'TREND_DOWN') {
    // Structure-backed trend does not need EMA confidence ≥ 0.55
    if (trend.confidence >= 0.55 || trend.evidence.some((e) => e.includes('STRUCTURE'))) {
      return trend;
    }
  }

  const rev = classifyReversal(input);
  if (rev && trend.confidence < 0.5) return rev;

  if (brk) return brk;
  if (vol) return vol;

  // RANGE only when proven — never MIXED_EMA → Donchian fallback
  const range = classifyRange(input);
  if (range.regime === 'RANGE') return range;
  if (range.regime === 'TREND_UP' || range.regime === 'TREND_DOWN') return range;
  if (trend.regime === 'TREND_UP' || trend.regime === 'TREND_DOWN') return trend;
  return range.regime === 'TRANSITION' ? range : trend;
}

/** Simple hysteresis helper for residence time. */
export type RegimeMachineState = {
  current: RegimeId;
  candidate: RegimeId | null;
  candidateSince: string | null;
  lastTransition: string | null;
  confidence: number;
};

export function applyHysteresis(
  machine: RegimeMachineState,
  next: RegimeResult,
  nowMs: number,
  minResidenceMs: number
): RegimeMachineState {
  if (next.regime === machine.current) {
    return { ...machine, confidence: next.confidence, candidate: null, candidateSince: null };
  }
  // TREND → RANGE requires full dwell; TREND → TRANSITION can stage immediately
  const trendToRange =
    (machine.current === 'TREND_UP' || machine.current === 'TREND_DOWN') &&
    next.regime === 'RANGE';
  if (trendToRange) {
    // Stage as TRANSITION first if not already dwelling on RANGE
    if (!machine.candidate || machine.candidate !== 'RANGE') {
      return {
        ...machine,
        current: 'TRANSITION',
        candidate: 'RANGE',
        candidateSince: new Date(nowMs).toISOString(),
        confidence: next.confidence,
        lastTransition: new Date(nowMs).toISOString(),
      };
    }
  }
  if (!machine.candidate || machine.candidate !== next.regime) {
    return {
      ...machine,
      candidate: next.regime,
      candidateSince: new Date(nowMs).toISOString(),
      confidence: next.confidence,
    };
  }
  const since = machine.candidateSince ? Date.parse(machine.candidateSince) : nowMs;
  if (nowMs - since < minResidenceMs) {
    return { ...machine, confidence: next.confidence };
  }
  return {
    current: next.regime,
    candidate: null,
    candidateSince: null,
    lastTransition: new Date(nowMs).toISOString(),
    confidence: next.confidence,
  };
}

/**
 * One-shot classify (no sticky global machine).
 * For dwell/persistence use classifyRegimeWithHysteresis + applyHysteresis.
 */
export function classifyRegime(input: RegimeInput): RegimeResult {
  return classifyRegimeRaw(input);
}

/**
 * Classify with hysteresis — TREND must dwell before RANGE.
 * This is the path that actually uses applyHysteresis.
 */
export function classifyRegimeWithHysteresis(
  input: RegimeInput,
  machine: RegimeMachineState,
  nowMs = Date.now(),
  minResidenceMs = 15_000
): { result: RegimeResult; machine: RegimeMachineState } {
  const raw = classifyRegimeRaw(input);
  const nextMachine = applyHysteresis(machine, raw, nowMs, minResidenceMs);
  if (nextMachine.current === raw.regime) {
    return { result: raw, machine: nextMachine };
  }
  return {
    result: {
      ...raw,
      regime: nextMachine.current,
      confidence: nextMachine.confidence,
      evidence: [
        ...raw.evidence,
        `HYSTERESIS_HELD=${machine.current}`,
        `CANDIDATE=${nextMachine.candidate || 'none'}`,
      ],
    },
    machine: nextMachine,
  };
}

/** @deprecated empty — machines are caller-owned via classifyRegimeWithHysteresis */
export function resetRegimeMachines(): void {
  /* no global machine store */
}
