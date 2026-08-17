/** Deterministic indicators — no broker calls, no random. */
export declare function sma(values: number[], period: number): number | null;
export declare function ema(values: number[], period: number): number | null;
export declare function atr(highs: number[], lows: number[], closes: number[], period: number): number | null;
export declare function rsi(closes: number[], period: number): number | null;
export declare function slope(values: number[], period: number): number | null;
export declare function bollinger(values: number[], period: number, mult?: number): {
    mid: number;
    upper: number;
    lower: number;
    width: number;
} | null;
export declare function donchian(highs: number[], lows: number[], period: number): {
    high: number;
    low: number;
    mid: number;
} | null;
export declare function roc(values: number[], period: number): number | null;
export declare function momentum(values: number[], period: number): number | null;
export declare function macd(values: number[], fast?: number, slow?: number, signalPeriod?: number): {
    macd: number;
    signal: number;
    histogram: number;
} | null;
/** Simplified ADX from DX of +DM/-DM over period (deterministic). */
export declare function adx(highs: number[], lows: number[], closes: number[], period: number): number | null;
/** Realized volatility = stdev of log returns over period. */
export declare function volatility(closes: number[], period: number): number | null;
export declare function swingHighs(highs: number[], lookback: number): number[];
export declare function swingLows(lows: number[], lookback: number): number[];
export declare function supportResistance(highs: number[], lows: number[], lookback: number): {
    support: number | null;
    resistance: number | null;
};
/** Trend strength proxy: |slope| normalized by ATR when available. */
export declare function trendStrength(closes: number[], period: number, atrValue: number | null): number | null;
