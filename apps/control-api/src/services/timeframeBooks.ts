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
import { analyzeMarketStructure, type StructureBar } from './marketStructure.js';
import { buildScalpZone } from './zones.js';
import {
  classifyBarGapWithSession,
  sessionMetaForEpic,
  type TradingSessionMeta,
} from './tradingSessions.js';

/**
 * Classify gap — requires session metadata.
 * Without proven session break → unknown (#4 audit follow-up).
 * @deprecated Prefer classifyBarGapWithSession(session)
 */
export function classifyBarGap(
  prevMs: number,
  nextMs: number,
  stepMs: number,
  session?: TradingSessionMeta | null
): 'none' | 'session' | 'missing' | 'unknown' {
  return classifyBarGapWithSession(prevMs, nextMs, stepMs, session ?? null);
}

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
  /** Seed retry backoff (#22) */
  seed_fail_count?: number;
  seed_next_allowed_ms?: number;
  /** Per-TF last refresh (#23) */
  last_refresh_ms?: Partial<Record<Exclude<TfKey, '10s'>, number>>;
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
    seed_fail_count: 0,
    seed_next_allowed_ms: 0,
    last_refresh_ms: {},
  };
}

/** Refresh cadence per TF (#23/#60). */
export const TF_REFRESH_MS: Record<Exclude<TfKey, '10s'>, number> = {
  '1m': 15_000,
  '5m': 30_000,
  '15m': 90_000,
  '1H': 300_000,
  '4H': 900_000,
};

export function seedBackoffMs(failCount: number): number {
  // 5s, 10s, 20s, 40s … cap 5min
  return Math.min(300_000, 5_000 * Math.pow(2, Math.max(0, failCount - 1)));
}

/**
 * Readiness = warmup closed count + Wilder ATR computable + quality (#69).
 * Gaps classified with instrument session metadata — UNKNOWN gap = NOT_READY.
 */
export function evaluateTfBook(
  tf: Exclude<TfKey, '10s'>,
  bars: TfBar[],
  source: TfBook['source'],
  nowMs = Date.now(),
  session?: TradingSessionMeta | null
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

  const sess = session ?? null;
  let missingGaps = 0;
  let unknownGaps = 0;
  let sessionGaps = 0;
  for (let i = 1; i < closed.length; i++) {
    const kind = classifyBarGap(
      closed[i - 1]!.open_time_ms,
      closed[i]!.open_time_ms,
      TF_MS[tf],
      sess
    );
    if (kind === 'missing') missingGaps += 1;
    else if (kind === 'unknown') unknownGaps += 1;
    else if (kind === 'session') sessionGaps += 1;
  }

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
    missingGaps === 0 &&
    unknownGaps === 0 &&
    spanOk &&
    source !== 'EMPTY';

  let detail: string;
  if (ready) {
    detail = `${tf} OK · ${closed.length} closed · ATR ${atr!.toFixed(6)} · ${source} · sessionGaps=${sessionGaps}`;
  } else if (unknownGaps > 0) {
    detail = `${tf} NOT READY · unknown gaps ${unknownGaps} (need session metadata) · ${source}`;
  } else if (missingGaps > 0) {
    detail = `${tf} NOT READY · missing-data gaps ${missingGaps} · ${source}`;
  } else if (closed.length < min) {
    detail = `${tf} NOT READY · warmup ${closed.length}/${min} · ${source}`;
  } else if (atr == null) {
    detail = `${tf} NOT READY · ATR warmup incomplete · ${closed.length} closed · ${source}`;
  } else if (!quality.ok) {
    detail = `${tf} NOT READY · quality ${quality.reason} · ${source}`;
  } else if (!spanOk) {
    detail = `${tf} NOT READY · insufficient span · ${source}`;
  } else {
    detail = `${tf} NOT READY · ${closed.length}/${min} · ${quality.reason} · ${source}`;
  }

  return {
    tf,
    bars: closed,
    quality: { ...quality, gaps: missingGaps + unknownGaps },
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

/** HTF context from 4H + 1H + 15m hierarchy with market structure (#20/#21). */
export function buildHtfContextFromBooks(
  state: MultiTfState,
  price: number
): {
  trend: 'UP' | 'DOWN' | 'RANGE' | null;
  near_support: boolean;
  near_resistance: boolean;
  detail: string;
} {
  const toStruct = (bars: TfBar[]): StructureBar[] =>
    bars.map((b) => ({
      open_time_ms: b.open_time_ms,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ticks: b.ticks,
      provenance: b.provenance,
      forming: b.forming,
    }));

  const h4 = state.books['4H'];
  const h1 = state.books['1H'];
  const m15 = state.books['15m'];

  // Require all three books ready — no single-TF fallback invent (#20)
  if (!h4.ready || !h1.ready || !m15.ready) {
    return {
      trend: null,
      near_support: false,
      near_resistance: false,
      detail: 'HTF NOT READY · need 4H+1H+15m',
    };
  }

  const ms4 = analyzeMarketStructure(toStruct(h4.bars), { pivotLeft: 1, pivotRight: 1 });
  const ms1 = analyzeMarketStructure(toStruct(h1.bars), { pivotLeft: 1, pivotRight: 1 });
  const ms15 = analyzeMarketStructure(toStruct(m15.bars), { pivotLeft: 1, pivotRight: 1 });

  const biasOf = (trend: string | null | undefined): number =>
    trend === 'UP' ? 1 : trend === 'DOWN' ? -1 : 0;
  // Weight 4H > 1H > 15m
  const score = biasOf(ms4.trend) * 3 + biasOf(ms1.trend) * 2 + biasOf(ms15.trend) * 1;
  let trend: 'UP' | 'DOWN' | 'RANGE' | null = 'RANGE';
  if (score >= 3) trend = 'UP';
  else if (score <= -3) trend = 'DOWN';
  else if (ms4.trend === 'UP' || ms4.trend === 'DOWN') trend = ms4.trend;
  else trend = 'RANGE';

  const zone15 = buildScalpZone(
    m15.bars.map((b) => ({
      open_time_ms: b.open_time_ms,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ticks: b.ticks,
      provenance: b.provenance,
    }))
  );
  const near_support =
    (ms15.last_swing_low != null && price <= ms15.last_swing_low.price * 1.001) ||
    (zone15 != null && price <= zone15.low + (zone15.high - zone15.low) * 0.25);
  const near_resistance =
    (ms15.last_swing_high != null && price >= ms15.last_swing_high.price * 0.999) ||
    (zone15 != null && price >= zone15.high - (zone15.high - zone15.low) * 0.25);

  const bos =
    ms4.events.some((e) => e.kind === 'BOS' || e.kind === 'CHOCH') ||
    ms1.events.some((e) => e.kind === 'BOS' || e.kind === 'CHOCH');

  return {
    trend,
    near_support: Boolean(near_support),
    near_resistance: Boolean(near_resistance),
    detail: `HTF ${trend} · 4H ${ms4.trend}/${ms4.swing_labels.high}/${ms4.swing_labels.low} · 1H ${ms1.trend} · 15m ${ms15.trend} · bos/choch=${bos} · nearS=${Boolean(near_support)} nearR=${Boolean(near_resistance)}`,
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
