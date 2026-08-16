/** Signal builder — Signal != order. Persist decisions including NO TRADE. */

export type SignalDirection = 'LONG' | 'SHORT' | 'NONE';

export type TradingSignal = {
  signalId: string;
  symbol: string;
  direction: SignalDirection;
  strategy: string;
  strategyVersion: string;
  regime: string;
  regimeConfidence: number;
  timeframe: string;
  entryReference: number | null;
  stopReference: number | null;
  targetReference: number | null;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  evidence: string[];
  invalidationReasons: string[];
};

export type StrategyDecisionRecord = {
  strategy: string;
  strategyVersion: string;
  regime: string;
  result: 'SIGNAL' | 'NO_TRADE';
  signal: TradingSignal | null;
  reasons: string[];
  createdAt: string;
};

export function buildSignal(input: {
  signalId: string;
  symbol: string;
  direction: SignalDirection;
  strategy: string;
  strategyVersion?: string;
  regime: string;
  regimeConfidence?: number;
  timeframe: string;
  entryReference: number | null;
  stopReference: number | null;
  targetReference: number | null;
  confidence: number;
  ttlMs: number;
  evidence: string[];
}): TradingSignal {
  const createdAt = new Date().toISOString();
  return {
    signalId: input.signalId,
    symbol: input.symbol,
    direction: input.direction,
    strategy: input.strategy,
    strategyVersion: input.strategyVersion || '1',
    regime: input.regime,
    regimeConfidence: input.regimeConfidence ?? 0,
    timeframe: input.timeframe,
    entryReference: input.entryReference,
    stopReference: input.stopReference,
    targetReference: input.targetReference,
    confidence: input.confidence,
    createdAt,
    expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    evidence: input.evidence,
    invalidationReasons: [],
  };
}

export function isSignalExpired(s: TradingSignal, now = Date.now()): boolean {
  return Date.parse(s.expiresAt) <= now;
}

export function recordNoTrade(input: {
  strategy: string;
  strategyVersion?: string;
  regime: string;
  reasons: string[];
}): StrategyDecisionRecord {
  return {
    strategy: input.strategy,
    strategyVersion: input.strategyVersion || '1',
    regime: input.regime,
    result: 'NO_TRADE',
    signal: null,
    reasons: input.reasons,
    createdAt: new Date().toISOString(),
  };
}

export function dedupeKey(s: Pick<TradingSignal, 'symbol' | 'direction' | 'strategy' | 'timeframe'>): string {
  return `${s.symbol}|${s.direction}|${s.strategy}|${s.timeframe}`;
}
