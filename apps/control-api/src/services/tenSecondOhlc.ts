/** Native confirm OHLC — 2s buckets for faster arm→entry (was Capital 10s). */

/** Closed-bar confirm period for setup entry (was 10_000). */
export const ENTRY_BAR_MS = 2_000;

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
  return Math.floor(tsMs / ENTRY_BAR_MS) * ENTRY_BAR_MS;
}

export function bodyPct(bar: Pick<TenSecBar, 'open' | 'close'>): number {
  const mid = Math.max(Math.abs(bar.open), 1e-9);
  return (bar.close - bar.open) / mid;
}

export function rangePct(bar: Pick<TenSecBar, 'open' | 'high' | 'low'>): number {
  const mid = Math.max(Math.abs(bar.open), 1e-9);
  return (bar.high - bar.low) / mid;
}

/** Visible on a Capital 10s chart — not tick-to-tick noise. */
export function isMoving10s(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return false;
  return Math.abs(bodyPct(bar)) >= 0.00015 || rangePct(bar) >= 0.00025;
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

/** Fold Capital 1-second candles into completed confirm bars (oldest → newest). */
export function aggregateSecondsToTen(seconds: CapitalOhlc[]): TenSecBar[] {
  if (seconds.length < 2) return [];
  const chunk = Math.max(1, Math.round(ENTRY_BAR_MS / 1000));
  const bars: TenSecBar[] = [];
  for (let i = 0; i + chunk <= seconds.length; i += chunk) {
    const slice = seconds.slice(i, i + chunk);
    const first = slice[0]!;
    bars.push({
      open_time_ms: i * 1000,
      open: first.open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1]!.close,
      ticks: slice.length,
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
  // Wick/range without directional body — still not FLAT, but no fade signal
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
