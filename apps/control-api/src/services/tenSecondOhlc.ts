/** OHLC bars — live brain uses 10-SECOND buckets (SO scalp). */
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
 * Expand Capital MINUTE candles into synthetic 10s bars (6 per minute).
 * Seeds ~25 min zone history when SECOND feed alone cannot fill 150 bars.
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
      });
    }
  }
  return bars;
}

/**
 * Fold Capital MINUTE candles into completed 5-minute bars (oldest → newest).
 * Chunks of 5 by array order (Capital returns chronological).
 */
export function aggregateMinutesToFive(minutes: CapitalOhlc[]): TenSecBar[] {
  if (minutes.length < 5) return [];
  const bars: TenSecBar[] = [];
  const complete = Math.floor(minutes.length / 5) * 5;
  for (let i = 0; i + 5 <= complete; i += 5) {
    const chunk = minutes.slice(i, i + 5);
    const first = chunk[0]!;
    bars.push({
      open_time_ms: i * 60_000,
      open: first.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1]!.close,
      ticks: chunk.length,
    });
  }
  return bars;
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
