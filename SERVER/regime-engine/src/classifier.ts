/**
 * Full regime set — confidence + evidence. Never places orders.
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
  | 'NO_TRADE';

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

export function classifyTrend(input: RegimeInput): RegimeResult {
  const { closes } = input;
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  const sl = slope(closes, 10);
  if (fast == null || slow == null || sl == null) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      evidence: ['INSUFFICIENT_SERIES'],
      invalidations: [],
      no_trade_reasons: ['NO_CONFIDENCE'],
    };
  }
  if (fast > slow && sl > 0) {
    return {
      regime: 'TREND_UP',
      confidence: Math.min(1, 0.45 + Math.min(0.4, Math.abs(sl) * 50)),
      evidence: ['FAST_EMA_ABOVE_SLOW', 'POSITIVE_SLOPE'],
      invalidations: [],
    };
  }
  if (fast < slow && sl < 0) {
    return {
      regime: 'TREND_DOWN',
      confidence: Math.min(1, 0.45 + Math.min(0.4, Math.abs(sl) * 50)),
      evidence: ['FAST_EMA_BELOW_SLOW', 'NEGATIVE_SLOPE'],
      invalidations: [],
    };
  }
  return {
    regime: 'RANGE',
    confidence: 0.4,
    evidence: ['MIXED_EMA_SLOPE'],
    invalidations: ['NO_CLEAR_TREND'],
  };
}

export function classifyRange(input: RegimeInput): RegimeResult {
  const d = donchian(input.highs, input.lows, 20);
  if (!d) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      evidence: ['INSUFFICIENT_SERIES'],
      invalidations: [],
      no_trade_reasons: ['NO_CONFIDENCE'],
    };
  }
  return {
    regime: 'RANGE',
    confidence: 0.55,
    evidence: [`RANGE_HIGH=${d.high}`, `RANGE_LOW=${d.low}`],
    invalidations: [],
    rangeHigh: d.high,
    rangeLow: d.low,
    rangeMid: d.mid,
    rangeWidth: d.high - d.low,
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

export function classifyRegime(input: RegimeInput): RegimeResult {
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
    if (trend.confidence >= 0.55) return trend;
  }

  const rev = classifyReversal(input);
  if (rev && trend.confidence < 0.5) return rev;

  if (brk) return brk;
  if (vol) return vol;
  if (trend.regime === 'RANGE' || trend.confidence < 0.55) {
    return classifyRange(input);
  }
  return trend;
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
