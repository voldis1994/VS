/** Deterministic indicators — no broker calls, no random. */
export function sma(values, period) {
    if (period < 1 || values.length < period)
        return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}
export function ema(values, period) {
    if (period < 1 || values.length < period)
        return null;
    const k = 2 / (period + 1);
    let prev = sma(values.slice(0, period), period);
    if (prev == null)
        return null;
    for (let i = period; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
    }
    return prev;
}
export function atr(highs, lows, closes, period) {
    if (period < 1 || highs.length < period + 1 || lows.length !== highs.length || closes.length !== highs.length) {
        return null;
    }
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        trs.push(tr);
    }
    return sma(trs, period);
}
export function rsi(closes, period) {
    if (period < 1 || closes.length < period + 1)
        return null;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0)
            gains += d;
        else
            losses -= d;
    }
    if (losses === 0)
        return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
}
export function slope(values, period) {
    if (period < 2 || values.length < period)
        return null;
    const slice = values.slice(-period);
    const n = slice.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += slice[i];
        sumXY += i * slice[i];
        sumXX += i * i;
    }
    const den = n * sumXX - sumX * sumX;
    if (den === 0)
        return null;
    return (n * sumXY - sumX * sumY) / den;
}
export function bollinger(values, period, mult = 2) {
    const mid = sma(values, period);
    if (mid == null)
        return null;
    const slice = values.slice(-period);
    const variance = slice.reduce((a, v) => a + (v - mid) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = mid + mult * sd;
    const lower = mid - mult * sd;
    return { mid, upper, lower, width: upper - lower };
}
export function donchian(highs, lows, period) {
    if (period < 1 || highs.length < period || lows.length < period)
        return null;
    const h = Math.max(...highs.slice(-period));
    const l = Math.min(...lows.slice(-period));
    return { high: h, low: l, mid: (h + l) / 2 };
}
export function roc(values, period) {
    if (values.length <= period)
        return null;
    const cur = values[values.length - 1];
    const prev = values[values.length - 1 - period];
    if (prev === 0)
        return null;
    return ((cur - prev) / prev) * 100;
}
export function momentum(values, period) {
    if (values.length <= period)
        return null;
    return values[values.length - 1] - values[values.length - 1 - period];
}
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
    if (values.length < slow + signalPeriod)
        return null;
    const macdSeries = [];
    for (let i = slow; i <= values.length; i++) {
        const slice = values.slice(0, i);
        const f = ema(slice, fast);
        const s = ema(slice, slow);
        if (f == null || s == null)
            continue;
        macdSeries.push(f - s);
    }
    if (macdSeries.length < signalPeriod)
        return null;
    const signal = ema(macdSeries, signalPeriod);
    if (signal == null)
        return null;
    const macdVal = macdSeries[macdSeries.length - 1];
    return { macd: macdVal, signal, histogram: macdVal - signal };
}
/** Simplified ADX from DX of +DM/-DM over period (deterministic). */
export function adx(highs, lows, closes, period) {
    if (period < 1 || highs.length < period + 1)
        return null;
    const dxList = [];
    for (let i = 1; i < highs.length; i++) {
        const up = highs[i] - highs[i - 1];
        const down = lows[i - 1] - lows[i];
        const plusDM = up > down && up > 0 ? up : 0;
        const minusDM = down > up && down > 0 ? down : 0;
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        if (tr <= 0)
            continue;
        const plusDI = (plusDM / tr) * 100;
        const minusDI = (minusDM / tr) * 100;
        const sum = plusDI + minusDI;
        const dx = sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
        dxList.push(dx);
    }
    return sma(dxList, period);
}
/** Realized volatility = stdev of log returns over period. */
export function volatility(closes, period) {
    if (period < 2 || closes.length < period + 1)
        return null;
    const rets = [];
    for (let i = closes.length - period; i < closes.length; i++) {
        const prev = closes[i - 1];
        if (!(prev > 0) || !(closes[i] > 0))
            return null;
        rets.push(Math.log(closes[i] / prev));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
    return Math.sqrt(variance);
}
export function swingHighs(highs, lookback) {
    if (lookback < 1 || highs.length < lookback * 2 + 1)
        return [];
    const out = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
        const window = highs.slice(i - lookback, i + lookback + 1);
        if (highs[i] === Math.max(...window))
            out.push(highs[i]);
    }
    return out;
}
export function swingLows(lows, lookback) {
    if (lookback < 1 || lows.length < lookback * 2 + 1)
        return [];
    const out = [];
    for (let i = lookback; i < lows.length - lookback; i++) {
        const window = lows.slice(i - lookback, i + lookback + 1);
        if (lows[i] === Math.min(...window))
            out.push(lows[i]);
    }
    return out;
}
export function supportResistance(highs, lows, lookback) {
    const sh = swingHighs(highs, lookback);
    const sl = swingLows(lows, lookback);
    return {
        resistance: sh.length ? Math.max(...sh) : null,
        support: sl.length ? Math.min(...sl) : null,
    };
}
/** Trend strength proxy: |slope| normalized by ATR when available. */
export function trendStrength(closes, period, atrValue) {
    const s = slope(closes, period);
    if (s == null)
        return null;
    if (atrValue != null && atrValue > 0)
        return Math.abs(s) / atrValue;
    return Math.abs(s);
}
