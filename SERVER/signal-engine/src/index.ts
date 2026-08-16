/** Signal builder — Signal != order. */

export type SignalDirection = 'LONG' | 'SHORT' | 'NONE';

export type TradingSignal = {
  signalId: string;
  symbol: string;
  direction: SignalDirection;
  strategy: string;
  regime: string;
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

export function buildSignal(input: {
  signalId: string;
  symbol: string;
  direction: SignalDirection;
  strategy: string;
  regime: string;
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
    ...input,
    createdAt,
    expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    invalidationReasons: [],
  };
}

export function isSignalExpired(s: TradingSignal, now = Date.now()): boolean {
  return Date.parse(s.expiresAt) <= now;
}
