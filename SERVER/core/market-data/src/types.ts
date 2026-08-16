/**
 * Canonical market objects — never invent prices.
 */

export type SymbolId = string;

export type MarketTick = {
  symbol: SymbolId;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  source: string;
  sourceTimestamp: string;
  receivedTimestamp: string;
  sequence: number | null;
};

export type Quote = MarketTick;

export type Candle = {
  symbol: SymbolId;
  timeframe: Timeframe;
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';

export type MarketQualityState =
  | 'OK'
  | 'STALE'
  | 'GAP'
  | 'ABNORMAL_SPREAD'
  | 'UNAVAILABLE';

export type MarketSnapshot = {
  symbol: SymbolId;
  quote: MarketTick | null;
  quality: MarketQualityState;
  lastError: string | null;
};

export type TickValidation =
  | { ok: true; tick: MarketTick }
  | { ok: false; reason: string };

export function validateTick(input: {
  symbol: string;
  bid: number;
  ask: number;
  source: string;
  sourceTimestamp: string;
  receivedTimestamp?: string;
  sequence?: number | null;
  knownSymbols?: Set<string>;
}): TickValidation {
  const { symbol, bid, ask, source, sourceTimestamp } = input;
  if (!symbol) return { ok: false, reason: 'SYMBOL_EMPTY' };
  if (input.knownSymbols && !input.knownSymbols.has(symbol)) {
    return { ok: false, reason: 'SYMBOL_UNKNOWN' };
  }
  if (!(bid > 0)) return { ok: false, reason: 'BID_INVALID' };
  if (!(ask > 0)) return { ok: false, reason: 'ASK_INVALID' };
  if (ask < bid) return { ok: false, reason: 'ASK_LT_BID' };
  if (!sourceTimestamp || Number.isNaN(Date.parse(sourceTimestamp))) {
    return { ok: false, reason: 'TIMESTAMP_INVALID' };
  }
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const tick: MarketTick = {
    symbol,
    bid,
    ask,
    mid,
    spread,
    source,
    sourceTimestamp,
    receivedTimestamp: input.receivedTimestamp || new Date().toISOString(),
    sequence: input.sequence ?? null,
  };
  return { ok: true, tick };
}

export function isStale(
  tick: MarketTick,
  nowMs: number,
  maxAgeMs: number
): boolean {
  const t = Date.parse(tick.sourceTimestamp);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeMs;
}

export const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

export function timeframeMinutes(tf: Timeframe): number {
  switch (tf) {
    case 'M1':
      return 1;
    case 'M5':
      return 5;
    case 'M15':
      return 15;
    case 'M30':
      return 30;
    case 'H1':
      return 60;
    case 'H4':
      return 240;
    case 'D1':
      return 1440;
  }
}
