/**
 * Regime classification — confidence + evidence. Never places orders.
 */

export type RegimeId =
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'RANGE'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
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
};

import { ema, slope, donchian } from '../../indicators/src/index.js';

export function classifyNoTrade(input: RegimeInput): RegimeResult | null {
  const reasons: string[] = [];
  if (!input.marketAvailable) reasons.push('MARKET_FEED_UNAVAILABLE');
  if (input.quoteAgeMs != null && input.quoteAgeMs > input.maxQuoteAgeMs) {
    reasons.push('STALE_QUOTE');
  }
  if (
    input.spread != null &&
    input.maxSpread != null &&
    input.spread > input.maxSpread
  ) {
    reasons.push('SPREAD_TOO_HIGH');
  }
  if (!input.brokerConnected) reasons.push('BROKER_DISCONNECTED');
  if (input.reconciliationPending) reasons.push('RECONCILIATION_PENDING');
  if (input.riskLimitHit) reasons.push('RISK_LIMIT');
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

export function classifyTrend(input: RegimeInput): RegimeResult {
  const { closes } = input;
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  const sl = slope(closes, 10);
  const evidence: string[] = [];
  const invalidations: string[] = [];
  if (fast == null || slow == null || sl == null) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      evidence: ['INSUFFICIENT_SERIES'],
      invalidations: [],
      no_trade_reasons: ['INSUFFICIENT_SERIES'],
    };
  }
  if (fast > slow && sl > 0) {
    evidence.push('FAST_EMA_ABOVE_SLOW', 'POSITIVE_SLOPE');
    const confidence = Math.min(1, 0.45 + Math.min(0.4, Math.abs(sl) * 50) + (fast - slow) / Math.max(1e-9, slow) * 5);
    return { regime: 'TREND_UP', confidence, evidence, invalidations };
  }
  if (fast < slow && sl < 0) {
    evidence.push('FAST_EMA_BELOW_SLOW', 'NEGATIVE_SLOPE');
    const confidence = Math.min(1, 0.45 + Math.min(0.4, Math.abs(sl) * 50) + (slow - fast) / Math.max(1e-9, slow) * 5);
    return { regime: 'TREND_DOWN', confidence, evidence, invalidations };
  }
  invalidations.push('NO_CLEAR_TREND');
  return { regime: 'RANGE', confidence: 0.4, evidence: ['MIXED_EMA_SLOPE'], invalidations };
}

export function classifyRange(input: RegimeInput): RegimeResult {
  const d = donchian(input.highs, input.lows, 20);
  if (!d) {
    return {
      regime: 'NO_TRADE',
      confidence: 0,
      evidence: ['INSUFFICIENT_SERIES'],
      invalidations: [],
      no_trade_reasons: ['INSUFFICIENT_SERIES'],
    };
  }
  const widthPct = d.mid !== 0 ? d.high - d.low : 0;
  const conf = widthPct > 0 ? Math.min(0.85, 0.35 + 1 / (1 + widthPct)) : 0.3;
  return {
    regime: 'RANGE',
    confidence: conf,
    evidence: [`RANGE_HIGH=${d.high}`, `RANGE_LOW=${d.low}`, `RANGE_MID=${d.mid}`],
    invalidations: [],
  };
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

/**
 * Primary classifier: fail-closed NO_TRADE first, then trend/range, optional vol overlay note in evidence.
 */
export function classifyRegime(input: RegimeInput): RegimeResult {
  const blocked = classifyNoTrade(input);
  if (blocked) return blocked;
  if (input.quoteAgeMs != null && input.quoteAgeMs > input.maxQuoteAgeMs) {
    return {
      regime: 'STALE_MARKET',
      confidence: 1,
      evidence: [`QUOTE_AGE_MS=${input.quoteAgeMs}`],
      invalidations: [],
      no_trade_reasons: ['STALE_QUOTE'],
    };
  }
  const trend = classifyTrend(input);
  const vol = classifyVolatility(input);
  if (vol && vol.confidence > 0.7 && trend.regime !== 'NO_TRADE') {
    return {
      ...vol,
      evidence: [...vol.evidence, `UNDERLYING=${trend.regime}`],
    };
  }
  if (trend.regime === 'RANGE' || trend.confidence < 0.5) {
    const range = classifyRange(input);
    return range.confidence >= trend.confidence ? range : trend;
  }
  return trend;
}
