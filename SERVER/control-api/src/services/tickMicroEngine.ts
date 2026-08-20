/**
 * Tick Micro Engine — rolling time-window metrics from validated ticks.
 * Uses time windows (500ms/1s/2s/5s/10–30s), never fabricates volume/order-flow.
 * Canonical OHLC remains market-intelligence ohlc10s; desk tenSecondOhlc is the adapter.
 */

export type ValidatedTick = {
  ts_ms: number;
  mid: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  /** Provider / quality tag — never invent OK */
  quality: 'OK' | 'DEGRADED' | 'STALE' | 'ERROR' | 'UNKNOWN';
  provider?: string;
};

export type TickMicroMetrics = {
  as_of_ms: number;
  tick_count_30s: number;
  velocity_500ms: number | null;
  velocity_1s: number | null;
  velocity_2s: number | null;
  velocity_5s: number | null;
  acceleration: number | null;
  tick_rate_1s: number;
  tick_rate_5s: number;
  up_ratio_5s: number | null;
  down_ratio_5s: number | null;
  direction_persistence: number | null;
  reversal_rate_5s: number | null;
  micro_volatility_5s: number | null;
  spread: number | null;
  spread_delta_2s: number | null;
  tick_burst: boolean;
  stalling: boolean;
  exhaustion_up: boolean;
  exhaustion_down: boolean;
  last_mid: number | null;
  /** Book-level quality — DEGRADED when fan-out/callback fails */
  quality: 'OK' | 'DEGRADED' | 'STALE' | 'ERROR' | 'UNKNOWN';
  fanout_error_count: number;
  last_fanout_error: string | null;
};

export type TickMicroBook = {
  instrument: string;
  ticks: ValidatedTick[];
  metrics: TickMicroMetrics;
};

const MAX_AGE_MS = 30_000;
const MAX_TICKS = 2_000;

export function emptyTickMicroMetrics(asOf = Date.now()): TickMicroMetrics {
  return {
    as_of_ms: asOf,
    tick_count_30s: 0,
    velocity_500ms: null,
    velocity_1s: null,
    velocity_2s: null,
    velocity_5s: null,
    acceleration: null,
    tick_rate_1s: 0,
    tick_rate_5s: 0,
    up_ratio_5s: null,
    down_ratio_5s: null,
    direction_persistence: null,
    reversal_rate_5s: null,
    micro_volatility_5s: null,
    spread: null,
    spread_delta_2s: null,
    tick_burst: false,
    stalling: false,
    exhaustion_up: false,
    exhaustion_down: false,
    last_mid: null,
    quality: 'OK',
    fanout_error_count: 0,
    last_fanout_error: null,
  };
}

export function createTickMicroBook(instrument: string): TickMicroBook {
  return {
    instrument: String(instrument || '').toUpperCase(),
    ticks: [],
    metrics: emptyTickMicroMetrics(),
  };
}

function prune(book: TickMicroBook, nowMs: number): void {
  const cutoff = nowMs - MAX_AGE_MS;
  while (book.ticks.length && book.ticks[0]!.ts_ms < cutoff) book.ticks.shift();
  if (book.ticks.length > MAX_TICKS) {
    book.ticks.splice(0, book.ticks.length - MAX_TICKS);
  }
}

function midAtOrBefore(ticks: ValidatedTick[], ts: number): number | null {
  for (let i = ticks.length - 1; i >= 0; --i) {
    const t = ticks[i]!;
    if (t.ts_ms <= ts) return t.mid;
  }
  return ticks[0]?.mid ?? null;
}

function velocity(ticks: ValidatedTick[], nowMs: number, windowMs: number): number | null {
  if (ticks.length < 2) return null;
  const last = ticks[ticks.length - 1]!;
  const older = midAtOrBefore(ticks, nowMs - windowMs);
  if (older == null || !(last.mid > 0)) return null;
  return (last.mid - older) / last.mid;
}

function windowTicks(ticks: ValidatedTick[], nowMs: number, windowMs: number): ValidatedTick[] {
  const cut = nowMs - windowMs;
  return ticks.filter((t) => t.ts_ms >= cut);
}

/** Recompute metrics from the rolling log. Pure time-window math. */
export function recomputeTickMicro(book: TickMicroBook, nowMs = Date.now()): TickMicroMetrics {
  prune(book, nowMs);
  const ticks = book.ticks;
  // Preserve fan-out failure counters/quality across recomputes (must not silently clear).
  const prevFanout = book.metrics.fanout_error_count;
  const prevFanoutErr = book.metrics.last_fanout_error;
  const prevQuality = book.metrics.quality;
  const m = emptyTickMicroMetrics(nowMs);
  m.fanout_error_count = prevFanout;
  m.last_fanout_error = prevFanoutErr;
  if (prevFanout > 0 || prevQuality === 'DEGRADED') {
    m.quality = 'DEGRADED';
  }
  m.tick_count_30s = ticks.length;
  if (!ticks.length) {
    book.metrics = m;
    return m;
  }
  const last = ticks[ticks.length - 1]!;
  m.last_mid = last.mid;
  m.spread = last.spread;
  if (last.quality === 'DEGRADED' || last.quality === 'STALE' || last.quality === 'ERROR') {
    m.quality = last.quality;
  } else if (prevFanout > 0) {
    m.quality = 'DEGRADED';
  }
  m.velocity_500ms = velocity(ticks, nowMs, 500);
  m.velocity_1s = velocity(ticks, nowMs, 1_000);
  m.velocity_2s = velocity(ticks, nowMs, 2_000);
  m.velocity_5s = velocity(ticks, nowMs, 5_000);

  if (m.velocity_1s != null && m.velocity_5s != null) {
    // Accel ≈ short velocity minus longer (normalized)
    m.acceleration = m.velocity_1s - m.velocity_5s / 5;
  }

  const w1 = windowTicks(ticks, nowMs, 1_000);
  const w5 = windowTicks(ticks, nowMs, 5_000);
  m.tick_rate_1s = w1.length;
  m.tick_rate_5s = w5.length / 5;

  let up = 0;
  let down = 0;
  let reversals = 0;
  let prevSign = 0;
  const rets: number[] = [];
  for (let i = 1; i < w5.length; i++) {
    const a = w5[i - 1]!;
    const b = w5[i]!;
    const d = b.mid - a.mid;
    if (d > 0) up += 1;
    else if (d < 0) down += 1;
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign && prevSign && sign !== prevSign) reversals += 1;
    if (sign) prevSign = sign;
    const rel = d / Math.max(Math.abs(a.mid), 1e-9);
    rets.push(rel);
  }
  const moves = up + down;
  if (moves > 0) {
    m.up_ratio_5s = up / moves;
    m.down_ratio_5s = down / moves;
    m.direction_persistence = (up - down) / moves;
    m.reversal_rate_5s = reversals / Math.max(moves - 1, 1);
  }
  if (rets.length >= 2) {
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const var_ =
      rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / rets.length;
    m.micro_volatility_5s = Math.sqrt(Math.max(var_, 0));
  }

  const olderSpread = (() => {
    const target = nowMs - 2_000;
    for (let i = ticks.length - 1; i >= 0; --i) {
      const t = ticks[i]!;
      if (t.ts_ms <= target && t.spread != null) return t.spread;
    }
    return null;
  })();
  if (m.spread != null && olderSpread != null) {
    m.spread_delta_2s = m.spread - olderSpread;
  }

  // Local baselines for normalization (not hard-coded 0.0000x alone).
  const vol = Math.max(m.micro_volatility_5s ?? 0, 1e-7);
  const rate5 = Math.max(m.tick_rate_5s, 0.25);

  // Burst vs own tick-rate baseline
  m.tick_burst = m.tick_rate_1s >= Math.max(3, rate5 * 2.2 + 1);

  // Stall: move small vs vol + quiet vs rate baseline
  const absVel2 = Math.abs(m.velocity_2s ?? 0);
  m.stalling =
    ticks.length >= 4 && absVel2 < vol * 0.6 && m.tick_rate_1s <= Math.max(1, rate5 * 0.5);

  // Exhaustion: still directional but accel flips vs vol + reversals rise
  const persist = m.direction_persistence ?? 0;
  const accel = m.acceleration ?? 0;
  const rev = m.reversal_rate_5s ?? 0;
  const vel5 = m.velocity_5s ?? 0;
  m.exhaustion_up =
    persist > 0.25 && vel5 > vol * 0.5 && accel < -(vol * 0.35) && rev > 0.3;
  m.exhaustion_down =
    persist < -0.25 && vel5 < -(vol * 0.5) && accel > vol * 0.35 && rev > 0.3;

  book.metrics = m;
  return m;
}

/** Velocity/accel significant vs local micro volatility. */
export function significantVelocity(
  vel: number | null | undefined,
  micro: TickMicroMetrics,
  mult = 1.0
): boolean {
  if (vel == null || !Number.isFinite(vel)) return false;
  const vol = Math.max(micro.micro_volatility_5s ?? 0, 1e-7);
  return Math.abs(vel) >= vol * mult;
}

export function signedSignificant(
  value: number | null | undefined,
  side: 'BUY' | 'SELL',
  micro: TickMicroMetrics,
  mult = 1.0
): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  const signed = side === 'BUY' ? value : -value;
  const vol = Math.max(micro.micro_volatility_5s ?? 0, 1e-7);
  return signed >= vol * mult;
}

/**
 * Estimate impulse origin mid from the tick log — earliest mid in the recent
 * directional run, NOT the price when phase was labeled IGNITION.
 */
export function estimateMoveStartMid(
  book: TickMicroBook,
  side: 'BUY' | 'SELL',
  nowMs = Date.now()
): number | null {
  const ticks = windowTicks(book.ticks, nowMs, 8_000);
  if (ticks.length < 3) return book.metrics.last_mid;
  const vol = Math.max(book.metrics.micro_volatility_5s ?? 0, 1e-7);
  const withSide = side === 'BUY' ? 1 : -1;

  // Walk forward; find first tick where cumulative move toward side exceeds vol.
  const anchor = ticks[0]!.mid;
  let start = ticks[0]!.mid;
  for (let i = 1; i < ticks.length; i++) {
    const m = ticks[i]!.mid;
    const cum = (m - anchor) * withSide;
    if (cum >= vol * 0.8) {
      // Origin = mid just before the run accelerated
      start = ticks[Math.max(0, i - 1)]!.mid;
      break;
    }
    start = m;
  }

  // Prefer earliest local extreme against the side within the window (dip before BUY climb)
  let extreme = ticks[0]!.mid;
  for (const t of ticks) {
    if (side === 'BUY' && t.mid < extreme) extreme = t.mid;
    if (side === 'SELL' && t.mid > extreme) extreme = t.mid;
  }
  const last = ticks[ticks.length - 1]!.mid;
  const fromExtreme = (last - extreme) * withSide;
  if (fromExtreme >= vol * 1.2) return extreme;
  return start;
}

/**
 * Ingest one validated tick. Rejects bad/stale/error quality and non-finite prices.
 * Event-driven — call on every validated quote/tick, not only robotDesk cycle.
 */
export function ingestValidatedTick(
  book: TickMicroBook,
  tick: ValidatedTick
): TickMicroMetrics {
  if (!Number.isFinite(tick.mid) || tick.mid <= 0) return book.metrics;
  if (!Number.isFinite(tick.ts_ms)) return book.metrics;
  if (tick.quality === 'ERROR' || tick.quality === 'STALE') {
    return recomputeTickMicro(book, tick.ts_ms);
  }
  const last = book.ticks[book.ticks.length - 1];
  // Dedup identical mid at same ms
  if (last && last.ts_ms === tick.ts_ms && Math.abs(last.mid - tick.mid) < 1e-12) {
    return book.metrics;
  }
  book.ticks.push({ ...tick });
  return recomputeTickMicro(book, tick.ts_ms);
}

const books = new Map<string, TickMicroBook>();

export function getTickMicroBook(instrument: string): TickMicroBook {
  const key = String(instrument || '').toUpperCase();
  let b = books.get(key);
  if (!b) {
    b = createTickMicroBook(key);
    books.set(key, b);
  }
  return b;
}

/** Test helper */
export function resetTickMicroBooks(): void {
  books.clear();
}

/**
 * Mark TickMicro quality DEGRADED when FeedManager fan-out callback throws.
 * Does not invent ticks — only quality / error counters.
 */
export function markTickMicroFanoutDegraded(
  instrument: string,
  err: unknown
): void {
  const book = getTickMicroBook(instrument);
  const msg = err instanceof Error ? err.message : String(err);
  book.metrics.quality = 'DEGRADED';
  book.metrics.fanout_error_count += 1;
  book.metrics.last_fanout_error = msg;
  book.metrics.as_of_ms = Date.now();
}
