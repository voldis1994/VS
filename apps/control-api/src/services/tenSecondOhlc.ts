/** Native 10-second OHLC — same TF as Capital.com 10s chart. */

import { ENTRY_DIP, ENTRY_RALLY, MOVE, MOVE_RANGE } from './regimeBands.js';

export type TenSecBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
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

export function bodyPct(bar: Pick<TenSecBar, 'open' | 'close'>): number {
  const mid = Math.max(Math.abs(bar.open), 1e-9);
  return (bar.close - bar.open) / mid;
}

export function rangePct(bar: Pick<TenSecBar, 'open' | 'high' | 'low'>): number {
  const mid = Math.max(Math.abs(bar.open), 1e-9);
  return (bar.high - bar.low) / mid;
}

/** Visible on a Capital 10s chart — MOVE / MOVE_RANGE from shared regimeBands ladder. */
export function isMoving10s(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return false;
  return Math.abs(bodyPct(bar)) >= MOVE || rangePct(bar) >= MOVE_RANGE;
}

export function emptyTenSecState(): TenSecState {
  return { forming: null, last_closed: null, just_closed: false };
}

export function updateTenSecondOhlc(state: TenSecState, price: number, tsMs: number): TenSecState {
  if (!Number.isFinite(price) || price <= 0) {
    return { ...state, just_closed: false };
  }
  const bucket = tenSecBucketMs(tsMs);
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

/** Fold Capital 1-second candles into completed 10-second bars (oldest → newest). */
export function aggregateSecondsToTen(seconds: CapitalOhlc[]): TenSecBar[] {
  if (seconds.length < 2) return [];
  const bars: TenSecBar[] = [];
  for (let i = 0; i + 10 <= seconds.length; i += 10) {
    const chunk = seconds.slice(i, i + 10);
    const first = chunk[0]!;
    bars.push({
      open_time_ms: i * 1000,
      open: first.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1]!.close,
      ticks: chunk.length,
    });
  }
  return bars;
}

/**
 * Expand Capital MINUTE candles into synthetic 10s bars (6 per minute) so a 30m zone
 * can be seeded — Capital SECOND max (~50) cannot fill ZONE_BARS=180.
 *
 * Do NOT copy full minute O/H/L/C onto every 10s bar (that looks like 1m EXPANSION).
 * Interpolate the body path; park minute hi/lo on the mid bucket so zone extremes survive.
 */
export function expandMinutesToTen(minutes: CapitalOhlc[], endMs = Date.now()): TenSecBar[] {
  if (!minutes.length) return [];
  const bars: TenSecBar[] = [];
  // Align to 10s buckets so seed timeline matches live updateTenSecondOhlc
  const alignedEnd = Math.floor(endMs / 10_000) * 10_000;
  const startMs = alignedEnd - minutes.length * 60_000;
  for (let i = 0; i < minutes.length; i++) {
    const m = minutes[i]!;
    const minuteStart = startMs + i * 60_000;
    for (let k = 0; k < 6; k++) {
      const o = m.open + (m.close - m.open) * (k / 6);
      const c = m.open + (m.close - m.open) * ((k + 1) / 6);
      const carryExt = k === 2;
      const high = carryExt ? Math.max(m.high, o, c) : Math.max(o, c);
      const low = carryExt ? Math.min(m.low, o, c) : Math.min(o, c);
      bars.push({
        open_time_ms: minuteStart + k * 10_000,
        open: o,
        high,
        low,
        close: c,
        ticks: 1,
      });
    }
  }
  return bars;
}

export function decideFromClosed10s(
  bar: TenSecBar
): { direction: 'BUY' | 'SELL'; reason: string } | null {
  const bp = bodyPct(bar);
  const rng = rangePct(bar);
  if (!isMoving10s(bar)) return null;
  if (bp <= ENTRY_DIP) {
    return {
      direction: 'BUY',
      reason: `10s OHLC pullback O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bp * 100).toFixed(3)}% range=${(rng * 100).toFixed(3)}% → BUY`,
    };
  }
  if (bp >= ENTRY_RALLY) {
    return {
      direction: 'SELL',
      reason: `10s OHLC rally O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bp * 100).toFixed(3)}% range=${(rng * 100).toFixed(3)}% → SELL`,
    };
  }
  // Wick/range without directional body — still not FLAT, but no fade signal
  return null;
}

export function publicOhlc10s(state: TenSecState): {
  last_o: number | null;
  last_h: number | null;
  last_l: number | null;
  last_c: number | null;
  forming_c: number | null;
  forming_body_pct: number | null;
  forming_range_pct: number | null;
  body_pct: number | null;
  range_pct: number | null;
  market: 'MOVING' | 'QUIET' | 'SEEDING';
} {
  const last = state.last_closed;
  const forming = state.forming;
  const formingBody = forming ? bodyPct(forming) : null;
  const formingRange = forming ? rangePct(forming) : null;
  if (!last) {
    return {
      last_o: null,
      last_h: null,
      last_l: null,
      last_c: null,
      forming_c: forming?.close ?? null,
      forming_body_pct: formingBody,
      forming_range_pct: formingRange,
      body_pct: null,
      range_pct: null,
      market: 'SEEDING',
    };
  }
  return {
    last_o: last.open,
    last_h: last.high,
    last_l: last.low,
    last_c: last.close,
    forming_c: forming?.close ?? null,
    forming_body_pct: formingBody,
    forming_range_pct: formingRange,
    body_pct: bodyPct(last),
    range_pct: rangePct(last),
    market: isMoving10s(last) ? 'MOVING' : 'QUIET',
  };
}
