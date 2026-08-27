/**
 * Multi-timeframe candle books — Capital historical is primary.
 * 10s is microstructure only; HTF must not be built primarily from 10s.
 */

import type { DataProvenance } from './ohlcQuality.js';
import {
  assessBarSeries,
  detectBarGap,
  detectDuplicateBar,
  type BarSeriesQuality,
} from './dataQuality.js';

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

/** Minimum closed bars before trading allowed. */
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

/** Closed-only series — prevents look-ahead on forming candle. */
export function closedBarsOnly(bars: TfBar[], nowMs: number, tf: TfKey): TfBar[] {
  const tfMs = TF_MS[tf];
  return bars.filter((b) => isClosedBar(b, nowMs, tfMs) && b.provenance !== 'SYNTHETIC');
}

export function parseCandleTimeMs(raw: unknown, fallbackIndex: number, stepMs: number, endMs: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  // Fallback: chronological oldest→newest ending at endMs
  return endMs - stepMs * (fallbackIndex + 1);
}

/**
 * Aggregate lower TF into higher TF using clock-aligned boundaries.
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
  const closed = closedBarsOnly(source, nowMs, fromTf);
  if (!closed.length) return [];

  const buckets = new Map<number, TfBar[]>();
  for (const b of closed) {
    const key = alignBucketMs(b.open_time_ms, toMs);
    // Reject bars that don't sit on a valid lower-TF boundary
    if (alignBucketMs(b.open_time_ms, fromMs) !== b.open_time_ms) continue;
    const arr = buckets.get(key) ?? [];
    arr.push(b);
    buckets.set(key, arr);
  }

  const expected = Math.round(toMs / fromMs);
  const out: TfBar[] = [];
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    // Forming higher TF bucket — exclude (look-ahead)
    if (key + toMs > nowMs) continue;
    const chunk = (buckets.get(key) ?? []).sort((a, b) => a.open_time_ms - b.open_time_ms);
    if (chunk.length < Math.max(2, Math.floor(expected * 0.6))) continue;
    // Contiguity check on aligned steps
    let contiguous = true;
    for (let i = 1; i < chunk.length; i++) {
      if (chunk[i]!.open_time_ms - chunk[i - 1]!.open_time_ms !== fromMs) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous && chunk.length < expected) continue;
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    out.push({
      open_time_ms: key,
      open: first.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: last.close,
      ticks: chunk.reduce((a, c) => a + (c.ticks || 1), 0),
      provenance: chunk.every((c) => c.provenance === 'REAL') ? 'REAL' : 'SYNTHETIC',
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

export function evaluateTfBook(
  tf: Exclude<TfKey, '10s'>,
  bars: TfBar[],
  source: TfBook['source'],
  nowMs = Date.now()
): TfBook {
  const closed = closedBarsOnly(bars, nowMs, tf);
  const quality = assessBarSeries(closed, TF_MS[tf]);
  const min = TF_MIN_CLOSED[tf];
  const ready =
    closed.length >= min &&
    quality.ok &&
    quality.duplicates < Math.max(2, closed.length * 0.1) &&
    source !== 'EMPTY';
  return {
    tf,
    bars: closed,
    quality,
    source,
    ready,
    detail: ready
      ? `${tf} OK · ${closed.length} closed · ${source} · gaps=${quality.gaps}`
      : `${tf} NOT READY · ${closed.length}/${min} · ${quality.reason} · ${source}`,
    last_seed_ms: nowMs,
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

/** HTF context from real 4H/1H/15m — not 10s zone. */
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
      byTime.set(b.open_time_ms, { ...prev, ...b, high: Math.max(prev.high, b.high), low: Math.min(prev.low, b.low) });
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
