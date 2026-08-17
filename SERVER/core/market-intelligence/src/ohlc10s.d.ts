/**
 * Canonical 10-second OHLC — deterministic UTC boundaries :00,:10,:20,:30,:40,:50.
 * Built only from validated ticks. Never fabricates empty candles with fake prices.
 */
import type { Candle10s, RawTickEvent } from './types.js';
export declare const TEN_SEC_MS = 10000;
/** Deterministic UTC bucket start (ms). */
export declare function candle10sBucketStartMs(tsMs: number): number;
export declare function candle10sBucketIso(tsMs: number): {
    start_ts: string;
    end_ts: string;
};
export type Ohlc10sBuilderState = {
    instrument: string;
    bucket_start_ms: number | null;
    forming: Candle10s | null;
    closed: Candle10s[];
};
export declare function emptyOhlc10sState(instrument: string): Ohlc10sBuilderState;
/**
 * Ingest one validated tick. Returns newly closed candle if boundary crossed.
 * Does not invent ticks for empty buckets.
 */
export declare function ingestTickTo10s(state: Ohlc10sBuilderState, tick: RawTickEvent): {
    state: Ohlc10sBuilderState;
    closed: Candle10s | null;
};
/** Aggregate closed 10s candles into larger TF (seconds must be multiple of 10). */
export declare function aggregateFrom10s(candles: Candle10s[], periodSeconds: number): Candle10s[];
/** No look-ahead: only candles whose end_ts <= asOf. */
export declare function candlesAvailableAt(candles: Candle10s[], asOfIso: string): Candle10s[];
