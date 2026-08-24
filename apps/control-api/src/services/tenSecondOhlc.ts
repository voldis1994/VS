/** Native 10-second OHLC — same TF as Capital.com 10s chart. */

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

/** Visible on a Capital 10s chart — not tick-to-tick noise. */
export function isMoving10s(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return false;
  return Math.abs(bodyPct(bar)) >= 0.00015 || rangePct(bar) >= 0.00025;
}

/**
 * Breakout body gate for live Gold/metals 10s.
 * Classic 0.015% (~0.7pt on XAU) missed real BO candles of 0.2–0.5pt.
 */
export const BREAKOUT_BODY_PCT = 0.000045;

export function isMovingBreakout10s(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return false;
  const body = Math.abs(bar.close - bar.open);
  return (
    Math.abs(bodyPct(bar)) >= BREAKOUT_BODY_PCT ||
    rangePct(bar) >= 0.00009 ||
    body >= 0.15
  );
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
    // Forming ticks mean we have live price — not stuck SEEDING forever
    if (state.forming && state.forming.ticks >= 1) {
      return {
        last_o: state.forming.open,
        last_h: state.forming.high,
        last_l: state.forming.low,
        last_c: state.forming.close,
        forming_c: state.forming.close,
        body_pct: bodyPct(state.forming),
        market: isMoving10s(state.forming) ? 'MOVING' : 'QUIET',
      };
    }
    return {
      last_o: null,
      last_h: null,
      last_l: null,
      last_c: null,
      forming_c: null,
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
