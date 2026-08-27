/** OHLC bars — LTF timing. Primary trading TF is 5m (see fiveMinuteBrain). */
import type { DataProvenance } from './ohlcQuality.js';

export const TEN_SEC_MS = 10_000;
/** Legacy helper kept for tests / aggregateMinutesToFive. */
export const FIVE_MIN_MS = 300_000;

export type TenSecBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  /** REAL tick/SECOND aggregate vs SYNTHETIC 1m expansion */
  provenance?: DataProvenance;
};

export type TenSecState = {
  forming: TenSecBar | null;
  last_closed: TenSecBar | null;
  just_closed: boolean;
};

export type CapitalOhlc = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export function tenSecBucketMs(tsMs: number): number {
  return Math.floor(tsMs / 10_000) * 10_000;
}

export function fiveMinBucketMs(tsMs: number): number {
  return Math.floor(tsMs / FIVE_MIN_MS) * FIVE_MIN_MS;
}

export function bodyPct(bar: Pick<TenSecBar, 'open' | 'close'>): number {
  const mid = Math.max(Math.abs(bar.open), 1e-9);
  return (bar.close - bar.open) / mid;
}

export function rangePct(bar: Pick<TenSecBar, 'open' | 'high' | 'low'>): number {
  const mid = Math.max(Math.abs(bar.open), 1e-9);
  return (bar.high - bar.low) / mid;
}

/** Legacy 10s moving check (tests / helpers). */
export function isMoving10s(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return false;
  return Math.abs(bodyPct(bar)) >= 0.00015 || rangePct(bar) >= 0.00025;
}

/** 5m moving — ~0.08% body or ~0.12% range ≈ 3.7–5.5pt Gold. */
export function isMoving5m(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return false;
  return Math.abs(bodyPct(bar)) >= 0.0008 || rangePct(bar) >= 0.0012;
}

export function emptyTenSecState(): TenSecState {
  return { forming: null, last_closed: null, just_closed: false };
}

function updateBucketOhlc(
  state: TenSecState,
  price: number,
  tsMs: number,
  bucketMs: number
): TenSecState {
  if (!Number.isFinite(price) || price <= 0) {
    return { ...state, just_closed: false };
  }
  const bucket = Math.floor(tsMs / bucketMs) * bucketMs;
  let forming = state.forming;
  let lastClosed = state.last_closed;
  let justClosed = false;

  if (!forming || forming.open_time_ms !== bucket) {
    if (forming && forming.ticks > 0) {
      lastClosed = forming;
      justClosed = true;
    }
    forming = {
      open_time_ms: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      ticks: 1,
      provenance: 'REAL',
    };
  } else {
    forming = {
      ...forming,
      high: Math.max(forming.high, price),
      low: Math.min(forming.low, price),
      close: price,
      ticks: forming.ticks + 1,
    };
  }
  return { forming, last_closed: lastClosed, just_closed: justClosed };
}

export function updateTenSecondOhlc(state: TenSecState, price: number, tsMs: number): TenSecState {
  return updateBucketOhlc(state, price, tsMs, 10_000);
}

/** Live 5-minute OHLC from mid ticks. */
export function updateFiveMinuteOhlc(state: TenSecState, price: number, tsMs: number): TenSecState {
  return updateBucketOhlc(state, price, tsMs, FIVE_MIN_MS);
}

/** Fold Capital 1-second candles into completed 10-second bars by clock buckets.
 * Requires real timestamps — never invents i*1000 (#15/#16).
 * Gaps inside a bucket → skip that bucket (no time compression).
 */
export function aggregateSecondsToTen(
  seconds: Array<CapitalOhlc & { open_time_ms?: number | null }>
): TenSecBar[] {
  if (seconds.length < 2) return [];
  const TEN = 10_000;
  const byBucket = new Map<number, Array<CapitalOhlc & { open_time_ms: number }>>();

  for (const c of seconds) {
    const t = c.open_time_ms;
    if (t == null || !Number.isFinite(t) || t <= 0) continue;
    const bucket = Math.floor(t / TEN) * TEN;
    // Second candles should land on 1s grid; refuse sub-ms invent
    const aligned = Math.floor(t / 1000) * 1000;
    const arr = byBucket.get(bucket) ?? [];
    arr.push({ ...c, open_time_ms: aligned });
    byBucket.set(bucket, arr);
  }

  const out: TenSecBar[] = [];
  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  for (const bucket of keys) {
    const rows = (byBucket.get(bucket) ?? []).sort((a, b) => a.open_time_ms - b.open_time_ms);
    const bySec = new Map<number, (typeof rows)[0]>();
    for (const r of rows) bySec.set(r.open_time_ms, r);
    // Full contiguous 10 seconds required
    let complete = true;
    const ordered: typeof rows = [];
    for (let i = 0; i < 10; i++) {
      const need = bucket + i * 1000;
      const hit = bySec.get(need);
      if (!hit) {
        complete = false;
        break;
      }
      ordered.push(hit);
    }
    if (!complete) continue;
    const first = ordered[0]!;
    out.push({
      open_time_ms: bucket,
      open: first.open,
      high: Math.max(...ordered.map((c) => c.high)),
      low: Math.min(...ordered.map((c) => c.low)),
      close: ordered[ordered.length - 1]!.close,
      ticks: ordered.length,
      provenance: 'REAL',
    });
  }
  return out;
}

/**
 * Expand Capital MINUTE candles into SYNTHETIC 10s bars (6 identical clones / minute).
 * For zone/regime seed ONLY — never microstructure / BOS / 10s entry.
 */
export function expandMinutesToTenSec(
  minutes: CapitalOhlc[],
  endMs = Date.now()
): TenSecBar[] {
  if (!minutes.length) return [];
  const bars: TenSecBar[] = [];
  const startMs = endMs - minutes.length * 60_000;
  for (let mi = 0; mi < minutes.length; mi++) {
    const m = minutes[mi]!;
    const minuteStart = startMs + mi * 60_000;
    for (let s = 0; s < 6; s++) {
      bars.push({
        open_time_ms: minuteStart + s * 10_000,
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.close,
        ticks: 6,
        provenance: 'SYNTHETIC',
      });
    }
  }
  return bars;
}

/**
 * Fold Capital MINUTE candles into completed 5-minute bars — clock-aligned only.
 * Requires open_time_ms on candles; never invents i*60_000.
 */
export function aggregateMinutesToFive(
  minutes: Array<CapitalOhlc & { open_time_ms?: number | null }>
): TenSecBar[] {
  if (minutes.length < 5) return [];
  const FIVE = FIVE_MIN_MS;
  const ONE = 60_000;
  const byBucket = new Map<number, Array<CapitalOhlc & { open_time_ms: number }>>();
  for (const m of minutes) {
    const t = m.open_time_ms;
    if (t == null || !Number.isFinite(t) || t <= 0) continue;
    const aligned = Math.floor(t / ONE) * ONE;
    const bucket = Math.floor(aligned / FIVE) * FIVE;
    const arr = byBucket.get(bucket) ?? [];
    arr.push({ ...m, open_time_ms: aligned });
    byBucket.set(bucket, arr);
  }
  const out: TenSecBar[] = [];
  for (const bucket of [...byBucket.keys()].sort((a, b) => a - b)) {
    const rows = (byBucket.get(bucket) ?? []).sort((a, b) => a.open_time_ms - b.open_time_ms);
    const byT = new Map(rows.map((r) => [r.open_time_ms, r]));
    const ordered: typeof rows = [];
    let complete = true;
    for (let i = 0; i < 5; i++) {
      const hit = byT.get(bucket + i * ONE);
      if (!hit) {
        complete = false;
        break;
      }
      ordered.push(hit);
    }
    if (!complete) continue;
    const first = ordered[0]!;
    out.push({
      open_time_ms: bucket,
      open: first.open,
      high: Math.max(...ordered.map((c) => c.high)),
      low: Math.min(...ordered.map((c) => c.low)),
      close: ordered[ordered.length - 1]!.close,
      ticks: ordered.length,
      provenance: 'REAL',
    });
  }
  return out;
}

export function decideFromClosed10s(
  bar: TenSecBar
): { direction: 'BUY' | 'SELL'; reason: string } | null {
  const bp = bodyPct(bar);
  const rng = rangePct(bar);
  if (!isMoving10s(bar)) return null;
  if (bp <= -0.00015) {
    return {
      direction: 'BUY',
      reason: `10s OHLC pullback O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bp * 100).toFixed(3)}% range=${(rng * 100).toFixed(3)}% → BUY`,
    };
  }
  if (bp >= 0.00015) {
    return {
      direction: 'SELL',
      reason: `10s OHLC rally O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bp * 100).toFixed(3)}% range=${(rng * 100).toFixed(3)}% → SELL`,
    };
  }
  return null;
}

export function publicOhlc10s(state: TenSecState): {
  last_o: number | null;
  last_h: number | null;
  last_l: number | null;
  last_c: number | null;
  forming_c: number | null;
  body_pct: number | null;
  market: 'MOVING' | 'QUIET' | 'SEEDING';
} {
  const last = state.last_closed;
  if (!last) {
    return {
      last_o: null,
      last_h: null,
      last_l: null,
      last_c: null,
      forming_c: state.forming?.close ?? null,
      body_pct: null,
      market: 'SEEDING',
    };
  }
  return {
    last_o: last.open,
    last_h: last.high,
    last_l: last.low,
    last_c: last.close,
    forming_c: state.forming?.close ?? null,
    body_pct: bodyPct(last),
    market: isMoving10s(last) ? 'MOVING' : 'QUIET',
  };
}
