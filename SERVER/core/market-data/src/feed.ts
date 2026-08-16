/**
 * Market-data feed lifecycle — never fabricates missing quotes.
 */

import {
  type MarketTick,
  type MarketQualityState,
  type Timeframe,
  type Candle,
  validateTick,
  isStale,
  timeframeMinutes,
} from './types.js';

export type FeedLifecycleState =
  | 'STOPPED'
  | 'CONNECTING'
  | 'LIVE'
  | 'DEGRADED'
  | 'STALE'
  | 'DISCONNECTED'
  | 'ERROR';

export type SymbolBook = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  sourceTimestamp: string | null;
  receiveTimestamp: string | null;
  lastValidQuote: MarketTick | null;
  quoteAgeMs: number | null;
  quality: MarketQualityState;
  lifecycle: FeedLifecycleState;
};

export type FeedConfig = {
  maxQuoteAgeMs: number;
  maxSpread: number | null;
  maxGapMs: number;
};

const DEFAULT_CFG: FeedConfig = {
  maxQuoteAgeMs: 5000,
  maxSpread: null,
  maxGapMs: 60_000,
};

export class MarketFeedBook {
  private books = new Map<string, SymbolBook>();
  private lastSeq = new Map<string, number>();
  private cfg: FeedConfig;
  private lifecycle: FeedLifecycleState = 'STOPPED';

  constructor(cfg: Partial<FeedConfig> = {}) {
    this.cfg = { ...DEFAULT_CFG, ...cfg };
  }

  getLifecycle(): FeedLifecycleState {
    return this.lifecycle;
  }

  setLifecycle(state: FeedLifecycleState): void {
    this.lifecycle = state;
  }

  getBook(symbol: string): SymbolBook | undefined {
    return this.books.get(symbol);
  }

  /** Apply a raw tick. Returns false if rejected (duplicate/out-of-order/invalid). */
  ingest(raw: {
    symbol: string;
    bid: number;
    ask: number;
    source: string;
    sourceTimestamp: string;
    receivedTimestamp?: string;
    sequence?: number | null;
  }): { accepted: boolean; reason?: string; book?: SymbolBook } {
    const v = validateTick(raw);
    if (!v.ok) return { accepted: false, reason: v.reason };

    const tick = v.tick;
    if (tick.sequence != null) {
      const prev = this.lastSeq.get(tick.symbol);
      if (prev != null && tick.sequence <= prev) {
        return { accepted: false, reason: 'DUPLICATE_OR_OUT_OF_ORDER' };
      }
      this.lastSeq.set(tick.symbol, tick.sequence);
    }

    const existing = this.books.get(tick.symbol);
    if (existing?.lastValidQuote) {
      const prevTs = Date.parse(existing.lastValidQuote.sourceTimestamp);
      const curTs = Date.parse(tick.sourceTimestamp);
      if (Number.isFinite(prevTs) && Number.isFinite(curTs) && curTs < prevTs) {
        return { accepted: false, reason: 'OUT_OF_ORDER_TIMESTAMP' };
      }
      if (
        Number.isFinite(prevTs) &&
        Number.isFinite(curTs) &&
        curTs - prevTs > this.cfg.maxGapMs
      ) {
        // Accept but mark GAP quality
        const book = this.writeBook(tick, 'GAP');
        this.lifecycle = this.lifecycle === 'STOPPED' ? 'LIVE' : 'DEGRADED';
        return { accepted: true, book };
      }
    }

    let quality: MarketQualityState = 'OK';
    if (this.cfg.maxSpread != null && tick.spread > this.cfg.maxSpread) {
      quality = 'ABNORMAL_SPREAD';
    }

    const book = this.writeBook(tick, quality);
    if (this.lifecycle === 'STOPPED' || this.lifecycle === 'CONNECTING') {
      this.lifecycle = 'LIVE';
    } else if (quality !== 'OK') {
      this.lifecycle = 'DEGRADED';
    } else if (this.lifecycle !== 'ERROR') {
      this.lifecycle = 'LIVE';
    }
    return { accepted: true, book };
  }

  refreshStaleness(nowMs = Date.now()): void {
    for (const [sym, book] of this.books) {
      if (!book.lastValidQuote) continue;
      if (isStale(book.lastValidQuote, nowMs, this.cfg.maxQuoteAgeMs)) {
        book.quality = 'STALE';
        book.quoteAgeMs = nowMs - Date.parse(book.lastValidQuote.sourceTimestamp);
        book.lifecycle = 'STALE';
        this.books.set(sym, book);
        this.lifecycle = 'STALE';
      } else {
        book.quoteAgeMs = nowMs - Date.parse(book.lastValidQuote.sourceTimestamp);
        this.books.set(sym, book);
      }
    }
  }

  private writeBook(tick: MarketTick, quality: MarketQualityState): SymbolBook {
    const book: SymbolBook = {
      symbol: tick.symbol,
      bid: tick.bid,
      ask: tick.ask,
      mid: tick.mid,
      spread: tick.spread,
      sourceTimestamp: tick.sourceTimestamp,
      receiveTimestamp: tick.receivedTimestamp,
      lastValidQuote: tick,
      quoteAgeMs: null,
      quality,
      lifecycle: this.lifecycle === 'STOPPED' ? 'LIVE' : this.lifecycle,
    };
    this.books.set(tick.symbol, book);
    return book;
  }
}

/** Aggregate mid ticks into OHLC candles for a timeframe. Missing ticks → no fabricated bars. */
export function aggregateCandles(
  ticks: MarketTick[],
  timeframe: Timeframe
): Candle[] {
  if (!ticks.length) return [];
  const mins = timeframeMinutes(timeframe);
  const bucketMs = mins * 60_000;
  const byBucket = new Map<number, MarketTick[]>();
  for (const t of ticks) {
    const ts = Date.parse(t.sourceTimestamp);
    if (!Number.isFinite(ts)) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const arr = byBucket.get(key) || [];
    arr.push(t);
    byBucket.set(key, arr);
  }
  const candles: Candle[] = [];
  for (const [openMs, arr] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    const mids = arr.map((t) => t.mid);
    candles.push({
      symbol: arr[0].symbol,
      timeframe,
      openTime: new Date(openMs).toISOString(),
      open: mids[0],
      high: Math.max(...mids),
      low: Math.min(...mids),
      close: mids[mids.length - 1],
      volume: null,
    });
  }
  return candles;
}
