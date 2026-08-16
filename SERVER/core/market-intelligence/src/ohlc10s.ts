/**
 * Canonical 10-second OHLC — deterministic UTC boundaries :00,:10,:20,:30,:40,:50.
 * Built only from validated ticks. Never fabricates empty candles with fake prices.
 */

import type { Candle10s, RawTickEvent } from './types.js';

export const TEN_SEC_MS = 10_000;

/** Deterministic UTC bucket start (ms). */
export function candle10sBucketStartMs(tsMs: number): number {
  return Math.floor(tsMs / TEN_SEC_MS) * TEN_SEC_MS;
}

export function candle10sBucketIso(tsMs: number): { start_ts: string; end_ts: string } {
  const start = candle10sBucketStartMs(tsMs);
  return {
    start_ts: new Date(start).toISOString(),
    end_ts: new Date(start + TEN_SEC_MS).toISOString(),
  };
}

export type Ohlc10sBuilderState = {
  instrument: string;
  bucket_start_ms: number | null;
  forming: Candle10s | null;
  closed: Candle10s[];
};

export function emptyOhlc10sState(instrument: string): Ohlc10sBuilderState {
  return { instrument, bucket_start_ms: null, forming: null, closed: [] };
}

function seedCandle(instrument: string, tick: RawTickEvent, bucketStart: number): Candle10s {
  const { start_ts, end_ts } = candle10sBucketIso(bucketStart);
  return {
    instrument,
    start_ts,
    end_ts,
    open: tick.mid,
    high: tick.mid,
    low: tick.mid,
    close: tick.mid,
    tick_count: 1,
    bid_open: tick.bid,
    bid_high: tick.bid,
    bid_low: tick.bid,
    bid_close: tick.bid,
    ask_open: tick.ask,
    ask_high: tick.ask,
    ask_low: tick.ask,
    ask_close: tick.ask,
    spread_min: tick.spread,
    spread_max: tick.spread,
    spread_mean: tick.spread,
    source_count: 1,
    quality_score: tick.source_quality === 'OK' ? 1 : 0.5,
    provenance: [tick.provider],
  };
}

function updateCandle(c: Candle10s, tick: RawTickEvent): Candle10s {
  const n = c.tick_count + 1;
  const providers = c.provenance.includes(tick.provider)
    ? c.provenance
    : [...c.provenance, tick.provider];
  return {
    ...c,
    high: Math.max(c.high, tick.mid),
    low: Math.min(c.low, tick.mid),
    close: tick.mid,
    tick_count: n,
    bid_high: Math.max(c.bid_high, tick.bid),
    bid_low: Math.min(c.bid_low, tick.bid),
    bid_close: tick.bid,
    ask_high: Math.max(c.ask_high, tick.ask),
    ask_low: Math.min(c.ask_low, tick.ask),
    ask_close: tick.ask,
    spread_min: Math.min(c.spread_min, tick.spread),
    spread_max: Math.max(c.spread_max, tick.spread),
    spread_mean: (c.spread_mean * c.tick_count + tick.spread) / n,
    source_count: providers.length,
    quality_score: Math.min(1, (c.quality_score * c.tick_count + (tick.source_quality === 'OK' ? 1 : 0.5)) / n),
    provenance: providers,
  };
}

/**
 * Ingest one validated tick. Returns newly closed candle if boundary crossed.
 * Does not invent ticks for empty buckets.
 */
export function ingestTickTo10s(
  state: Ohlc10sBuilderState,
  tick: RawTickEvent
): { state: Ohlc10sBuilderState; closed: Candle10s | null } {
  if (tick.instrument !== state.instrument) {
    return { state, closed: null };
  }
  const ts = Date.parse(tick.timestamp_source);
  if (!Number.isFinite(ts)) return { state, closed: null };
  const bucket = candle10sBucketStartMs(ts);

  if (state.forming == null || state.bucket_start_ms == null) {
    return {
      state: {
        ...state,
        bucket_start_ms: bucket,
        forming: seedCandle(state.instrument, tick, bucket),
      },
      closed: null,
    };
  }

  if (bucket === state.bucket_start_ms) {
    return {
      state: { ...state, forming: updateCandle(state.forming, tick) },
      closed: null,
    };
  }

  // Boundary crossed — close previous only if it had ticks (always true if forming exists)
  const closed = state.forming;
  const closedList = [...state.closed, closed];
  return {
    state: {
      instrument: state.instrument,
      bucket_start_ms: bucket,
      forming: seedCandle(state.instrument, tick, bucket),
      closed: closedList,
    },
    closed,
  };
}

/** Aggregate closed 10s candles into larger TF (seconds must be multiple of 10). */
export function aggregateFrom10s(
  candles: Candle10s[],
  periodSeconds: number
): Candle10s[] {
  if (periodSeconds < 10 || periodSeconds % 10 !== 0) return [];
  const bucketMs = periodSeconds * 1000;
  const groups = new Map<number, Candle10s[]>();
  for (const c of candles) {
    const t = Date.parse(c.start_ts);
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / bucketMs) * bucketMs;
    const arr = groups.get(key) || [];
    arr.push(c);
    groups.set(key, arr);
  }
  const out: Candle10s[] = [];
  for (const [start, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (!bars.length) continue;
    const first = bars[0]!;
    const last = bars[bars.length - 1]!;
    const provenance = [...new Set(bars.flatMap((b) => b.provenance))];
    out.push({
      instrument: first.instrument,
      start_ts: new Date(start).toISOString(),
      end_ts: new Date(start + bucketMs).toISOString(),
      open: first.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: last.close,
      tick_count: bars.reduce((a, b) => a + b.tick_count, 0),
      bid_open: first.bid_open,
      bid_high: Math.max(...bars.map((b) => b.bid_high)),
      bid_low: Math.min(...bars.map((b) => b.bid_low)),
      bid_close: last.bid_close,
      ask_open: first.ask_open,
      ask_high: Math.max(...bars.map((b) => b.ask_high)),
      ask_low: Math.min(...bars.map((b) => b.ask_low)),
      ask_close: last.ask_close,
      spread_min: Math.min(...bars.map((b) => b.spread_min)),
      spread_max: Math.max(...bars.map((b) => b.spread_max)),
      spread_mean: bars.reduce((a, b) => a + b.spread_mean, 0) / bars.length,
      source_count: provenance.length,
      quality_score: bars.reduce((a, b) => a + b.quality_score, 0) / bars.length,
      provenance,
    });
  }
  return out;
}

/** No look-ahead: only candles whose end_ts <= asOf. */
export function candlesAvailableAt(candles: Candle10s[], asOfIso: string): Candle10s[] {
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(asOf)) return [];
  return candles.filter((c) => Date.parse(c.end_ts) <= asOf);
}
