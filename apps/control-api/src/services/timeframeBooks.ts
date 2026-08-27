/**
 * Multi-timeframe candle books — Capital historical is primary.
 * 10s is microstructure only; HTF must not be built primarily from 10s.
 *
 * Critical UNKNOWN = BLOCK. Never invent timestamps. Gaps must not compress time.
 */

import type { DataProvenance } from './ohlcQuality.js';
import {
  assessBarSeries,
  detectBarGap,
  detectDuplicateBar,
  type BarSeriesQuality,
} from './dataQuality.js';
import { atrWilder } from './volatilityNorm.js';

export type TfKey = '10s' | '1m' | '5m' | '15m' | '1H' | '4H';

export type CapitalResolution =
  | 'SECOND'
  | 'MINUTE'
  | 'MINUTE_5'
  | 'MINUTE_15'
  | 'HOUR'
  | 'HOUR_4';

export type TfBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  provenance: DataProvenance;
  /** true while candle still forming (look-ahead unsafe for structure) */
  forming?: boolean;
  source_tf?: TfKey;
};

export const TF_MS: Record<TfKey, number> = {
  '10s': 10_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1H': 3_600_000,
  '4H': 14_400_000,
};

export const TF_RESOLUTION: Record<Exclude<TfKey, '10s'>, CapitalResolution> = {
  '1m': 'MINUTE',
  '5m': 'MINUTE_5',
  '15m': 'MINUTE_15',
  '1H': 'HOUR',
  '4H': 'HOUR_4',
};

/**
 * Warmup closed-bar counts — enough for Wilder ATR(14) + structure span.
 * Readiness also requires ATR computable (not mere count).
 */
export const TF_MIN_CLOSED: Record<Exclude<TfKey, '10s'>, number> = {
  '1m': 30,
  '5m': 40,
  '15m': 32,
  '1H': 24,
  '4H': 20,
};

/** Seed fetch sizes (Capital max typically 1000). */
export const TF_SEED_MAX: Record<Exclude<TfKey, '10s'>, number> = {
  '1m': 120,
  '5m': 100,
  '15m': 96,
  '1H': 72,
  '4H': 60,
};

export const HTF_KEYS: Array<Exclude<TfKey, '10s' | '1m'>> = ['4H', '1H', '15m', '5m'];
export const STRUCTURE_KEYS: Array<Exclude<TfKey, '10s'>> = ['4H', '1H', '15m', '5m', '1m'];

export function alignBucketMs(tsMs: number, tfMs: number): number {
  return Math.floor(tsMs / tfMs) * tfMs;
}

export function isClosedBar(bar: TfBar, nowMs: number, tfMs: number): boolean {
  if (bar.forming) return false;
  return bar.open_time_ms + tfMs <= nowMs;
}

/** Closed-only series — prevents look-ahead on forming candle (#67). */
export function closedBarsOnly(bars: TfBar[], nowMs: number, tf: TfKey): TfBar[] {
  const tfMs = TF_MS[tf];
  return bars.filter((b) => isClosedBar(b, nowMs, tfMs) && b.provenance !== 'SYNTHETIC');
}

/**
 * Parse candle timestamp — NEVER invent (#64/#65).
 * Missing / unparseable / future → null (caller blocks context).
 */
export function parseCandleTimeMs(raw: unknown, nowMs?: number): number | null {
  const now = nowMs ?? Date.now();
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    if (!(ms > 0) || ms > now + 5_000) return null;
    return Math.floor(ms);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw);
    if (!Number.isFinite(t) || t <= 0 || t > now + 5_000) return null;
    return t;
  }
  return null;
}

/**
 * Aggregate lower TF into higher TF using clock-aligned boundaries (#57).
 * Gaps must NOT compress time (#58): bucket accepted only when every expected
 * lower-TF step inside the bucket is present and contiguous.
 * Fallback only when native Capital resolution unavailable.
 */
export function aggregateAligned(
  source: TfBar[],
  fromTf: TfKey,
  toTf: TfKey,
  nowMs = Date.now()
): TfBar[] {
  const fromMs = TF_MS[fromTf];
  const toMs = TF_MS[toTf];
  if (toMs <= fromMs) return [];
  const expected = Math.round(toMs / fromMs);
  if (expected < 2) return [];

  const closed = closedBarsOnly(source, nowMs, fromTf);
  if (!closed.length) return [];

  const buckets = new Map<number, TfBar[]>();
  for (const b of closed) {
    // Reject bars that don't sit on a valid lower-TF boundary
    if (alignBucketMs(b.open_time_ms, fromMs) !== b.open_time_ms) continue;
    const key = alignBucketMs(b.open_time_ms, toMs);
    const arr = buckets.get(key) ?? [];
    arr.push(b);
    buckets.set(key, arr);
  }

  const out: TfBar[] = [];
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    // Forming higher TF bucket — exclude (look-ahead)
    if (key + toMs > nowMs) continue;

    const chunk = (buckets.get(key) ?? []).sort((a, b) => a.open_time_ms - b.open_time_ms);
    // Dedup by open_time
    const byT = new Map<number, TfBar>();
    for (const c of chunk) byT.set(c.open_time_ms, c);

    // Full coverage required — do not compress gaps into a shorter bar
    let complete = true;
    const ordered: TfBar[] = [];
    for (let i = 0; i < expected; i++) {
      const need = key + i * fromMs;
      const hit = byT.get(need);
      if (!hit) {
        complete = false;
        break;
      }
      ordered.push(hit);
    }
    if (!complete || ordered.length !== expected) continue;

    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    out.push({
      open_time_ms: key,
      open: first.open,
      high: Math.max(...ordered.map((c) => c.high)),
      low: Math.min(...ordered.map((c) => c.low)),
      close: last.close,
      ticks: ordered.reduce((a, c) => a + (c.ticks || 1), 0),
      provenance: ordered.every((c) => c.provenance === 'REAL') ? 'REAL' : 'SYNTHETIC',
      forming: false,
      source_tf: toTf,
    });
  }
  return out;
}

export type TfBook = {
  tf: TfKey;
  bars: TfBar[];
  quality: BarSeriesQuality;
  source: 'CAPITAL_NATIVE' | 'AGGREGATED_FALLBACK' | 'EMPTY';
  ready: boolean;
  detail: string;
  last_seed_ms: number;
  atr: number | null;
};

export type MultiTfState = {
  books: Record<Exclude<TfKey, '10s'>, TfBook>;
  ready: boolean;
  detail: string;
  seeded_at_ms: number | null;
};

export function emptyTfBook(tf: Exclude<TfKey, '10s'>): TfBook {
  return {
    tf,
    bars: [],
    quality: { ok: false, reason: 'empty', duplicates: 0, gaps: 0 },
    source: 'EMPTY',
    ready: false,
    detail: 'not seeded',
    last_seed_ms: 0,
    atr: null,
  };
}

export function emptyMultiTfState(): MultiTfState {
  return {
    books: {
      '1m': emptyTfBook('1m'),
      '5m': emptyTfBook('5m'),
      '15m': emptyTfBook('15m'),
      '1H': emptyTfBook('1H'),
      '4H': emptyTfBook('4H'),
    },
    ready: false,
    detail: 'multi-TF history not loaded',
    seeded_at_ms: null,
  };
}

/**
 * Readiness = warmup closed count + Wilder ATR computable + quality (#69).
 * Mere candle count is not enough.
 */
export function evaluateTfBook(
  tf: Exclude<TfKey, '10s'>,
  bars: TfBar[],
  source: TfBook['source'],
  nowMs = Date.now()
): TfBook {
  const closed = closedBarsOnly(bars, nowMs, tf);
  const quality = assessBarSeries(closed, TF_MS[tf]);
  const min = TF_MIN_CLOSED[tf];
  const ohlc = closed.map((b) => ({
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
  const atr = atrWilder(ohlc, 14);

  const gapBudget = Math.max(2, Math.floor(closed.length * 0.05));
  const spanOk =
    closed.length >= 2
      ? closed[closed.length - 1]!.open_time_ms - closed[0]!.open_time_ms >=
        (min - 1) * TF_MS[tf] * 0.75
      : false;

  const ready =
    closed.length >= min &&
    atr != null &&
    atr > 0 &&
    quality.ok &&
    quality.duplicates < Math.max(2, closed.length * 0.1) &&
    quality.gaps <= gapBudget &&
    spanOk &&
    source !== 'EMPTY';

  let detail: string;
  if (ready) {
    detail = `${tf} OK · ${closed.length} closed · ATR ${atr!.toFixed(6)} · ${source} · gaps=${quality.gaps}`;
  } else if (closed.length < min) {
    detail = `${tf} NOT READY · warmup ${closed.length}/${min} · ${source}`;
  } else if (atr == null) {
    detail = `${tf} NOT READY · ATR warmup incomplete · ${closed.length} closed · ${source}`;
  } else if (!quality.ok) {
    detail = `${tf} NOT READY · quality ${quality.reason} · ${source}`;
  } else if (quality.gaps > gapBudget) {
    detail = `${tf} NOT READY · excessive gaps ${quality.gaps} · ${source}`;
  } else if (!spanOk) {
    detail = `${tf} NOT READY · insufficient span · ${source}`;
  } else {
    detail = `${tf} NOT READY · ${closed.length}/${min} · ${quality.reason} · ${source}`;
  }

  return {
    tf,
    bars: closed,
    quality,
    source,
    ready,
    detail,
    last_seed_ms: nowMs,
    atr,
  };
}

export function evaluateMultiTfReady(state: MultiTfState): MultiTfState {
  const required: Array<Exclude<TfKey, '10s'>> = ['1m', '5m', '15m', '1H', '4H'];
  const bad = required.filter((k) => !state.books[k].ready);
  if (bad.length) {
    return {
      ...state,
      ready: false,
      detail: `waiting TF history · ${bad.map((k) => state.books[k].detail).join(' · ')}`,
    };
  }
  return {
    ...state,
    ready: true,
    detail: `multi-TF ready · 4H/1H/15m/5m/1m seeded`,
    seeded_at_ms: state.seeded_at_ms ?? Date.now(),
  };
}

/** HTF context from real 4H/1H/15m — not 10s zone. Closed bars only. */
export function buildHtfContextFromBooks(
  state: MultiTfState,
  price: number
): {
  trend: 'UP' | 'DOWN' | 'RANGE' | null;
  near_support: boolean;
  near_resistance: boolean;
  detail: string;
} {
  const h4 = state.books['4H'].bars;
  const h1 = state.books['1H'].bars;
  const m15 = state.books['15m'].bars;
  const series = h4.length >= 8 ? h4 : h1.length >= 8 ? h1 : m15;
  if (series.length < 8) {
    return { trend: null, near_support: false, near_resistance: false, detail: 'HTF seeding' };
  }
  const window = series.slice(-20);
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const net = last.close - first.open;
  const atrProxy =
    window.reduce((a, b) => a + (b.high - b.low), 0) / Math.max(window.length, 1);
  const thr = Math.max(atrProxy * 0.5, Math.abs(price) * 0.0008);
  let trend: 'UP' | 'DOWN' | 'RANGE' = 'RANGE';
  if (net >= thr) trend = 'UP';
  else if (net <= -thr) trend = 'DOWN';

  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  const band = Math.max(high - low, atrProxy);
  const near_support = price <= low + band * 0.25;
  const near_resistance = price >= high - band * 0.25;
  return {
    trend,
    near_support,
    near_resistance,
    detail: `HTF ${trend} · nearS=${near_support} nearR=${near_resistance} · bars=${window.length}`,
  };
}

export function mergeUniqueBars(existing: TfBar[], incoming: TfBar[]): TfBar[] {
  const byTime = new Map<number, TfBar>();
  for (const b of existing) byTime.set(b.open_time_ms, b);
  for (const b of incoming) {
    if (!Number.isFinite(b.open_time_ms) || b.open_time_ms < 0) continue;
    const prev = byTime.get(b.open_time_ms);
    if (!prev) {
      byTime.set(b.open_time_ms, b);
      continue;
    }
    // Prefer REAL over SYNTHETIC; prefer non-forming
    if (prev.provenance === 'SYNTHETIC' && b.provenance === 'REAL') {
      byTime.set(b.open_time_ms, b);
    } else if (prev.forming && !b.forming) {
      byTime.set(b.open_time_ms, b);
    } else if (!detectDuplicateBar(prev, b)) {
      byTime.set(b.open_time_ms, {
        ...prev,
        ...b,
        high: Math.max(prev.high, b.high),
        low: Math.min(prev.low, b.low),
      });
    }
  }
  return [...byTime.values()].sort((a, b) => a.open_time_ms - b.open_time_ms);
}

export function recentGapCount(bars: TfBar[], stepMs: number, lookback = 20): number {
  const w = bars.slice(-lookback);
  let gaps = 0;
  for (let i = 1; i < w.length; i++) {
    if (detectBarGap(w[i - 1], w[i]!, stepMs, stepMs * 1.5).gap) gaps += 1;
  }
  return gaps;
}
