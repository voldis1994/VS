/**
 * Offline TS-brain replay — classifyRegime → structure entry → Soft/Peak exits.
 * Measures expectancy on historical 10s bars without Capital.
 * Does NOT add entry blockers (no daily limits / % equity gates).
 */
import { decideEntryWithStructure, zoneGeometry } from './structureEntry.js';
import {
  classifyRegime,
  stabilizeRegime,
  MIN_BARS_FOR_ZONE,
  type RegimeName,
} from './regimes.js';
import {
  decideBestOutcomeExit,
  favorableMove,
  type ExitSide,
} from './exitManage.js';
import { type TenSecBar } from './tenSecondOhlc.js';
import {
  computeExpectancy,
  type ExpectancyReport,
  type ExpectancyTradeRow,
} from './tradeLedger.js';

export type ReplayTrade = ExpectancyTradeRow & {
  direction: ExitSide;
  entry_price: number;
  exit_price: number;
  entry_bar_i: number;
  exit_bar_i: number;
};

export type StrategyReplayResult = {
  trades: ReplayTrade[];
  expectancy: ExpectancyReport;
  bars: number;
  entries_attempted: number;
};

type OpenSim = {
  side: ExitSide;
  entry: number;
  entry_at_ms: number;
  entry_i: number;
  regime: RegimeName;
  setup: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  entry_zone: { hi: number; lo: number; mid: number; width: number } | null;
  hardinv_breach_since_ms: number;
  structure_breach_since_ms: number;
  peak_protect_armed: boolean;
};

type LocalBook = {
  current: RegimeName;
  previous: RegimeName;
  bars_in_current: number;
  pending: RegimeName | null;
  pending_count: number;
  since: string;
};

/**
 * Walk closed 10s bars. One position at a time. Pts-only (lot size irrelevant).
 * Optional round-trip spread subtracted from exit pts.
 */
export function replayStrategy(
  bars: TenSecBar[],
  opts?: { spread_pts?: number; max_hold_bars?: number }
): StrategyReplayResult {
  const spread = opts?.spread_pts ?? 0.15;
  const maxHold = opts?.max_hold_bars ?? 90;
  const trades: ReplayTrade[] = [];
  let open: OpenSim | null = null;
  let entries = 0;
  const book: LocalBook = {
    current: 'UNKNOWN',
    previous: 'UNKNOWN',
    bars_in_current: 0,
    pending: null,
    pending_count: 0,
    since: new Date(0).toISOString(),
  };

  for (let i = 0; i < bars.length; i++) {
    const history = bars.slice(0, i + 1);
    if (history.length < MIN_BARS_FOR_ZONE) continue;
    const bar = bars[i]!;
    const mid = bar.close;
    const nowMs = bar.open_time_ms + 10_000;
    const nowIso = new Date(nowMs).toISOString();

    const raw = classifyRegime(history, book.current);
    const confirmed = stabilizeRegime(book, raw, nowIso);

    if (open) {
      const fav = favorableMove(open.side, open.entry, mid);
      if (fav > open.mfe) open.mfe = fav;
      if (fav < open.mae) open.mae = fav;
      open.peak_retention = open.mfe > 0 ? Math.max(0, fav / open.mfe) : null;

      const body = bar.close - bar.open;
      const reverse =
        (open.side === 'BUY' && body < 0) || (open.side === 'SELL' && body > 0);
      if (reverse && open.mfe >= 1.0) open.peak_protect_armed = true;

      const snap = {
        open_side: open.side,
        entry_price: open.entry,
        entry_at: new Date(open.entry_at_ms).toISOString(),
        mfe: open.mfe,
        mae: open.mae,
        peak_retention: open.peak_retention,
        regime: confirmed,
        entry_regime: open.regime,
        entry_setup: open.setup,
        entry_zone: open.entry_zone,
        hardinv_breach_since_ms: open.hardinv_breach_since_ms,
        structure_breach_since_ms: open.structure_breach_since_ms,
      };
      const quote = { bid: mid - spread / 2, ask: mid + spread / 2, mid };

      let decision = decideBestOutcomeExit(snap, mid, 'live_loss', nowMs, quote);
      if (decision.hardinv_breaching) {
        if (!open.hardinv_breach_since_ms) open.hardinv_breach_since_ms = nowMs;
      } else {
        open.hardinv_breach_since_ms = 0;
      }
      if (decision.structure_breaching) {
        if (!open.structure_breach_since_ms) open.structure_breach_since_ms = nowMs;
      } else {
        open.structure_breach_since_ms = 0;
      }
      snap.hardinv_breach_since_ms = open.hardinv_breach_since_ms;
      snap.structure_breach_since_ms = open.structure_breach_since_ms;

      if (!decision.exit && open.peak_protect_armed) {
        decision = decideBestOutcomeExit(snap, mid, 'peak_protect_only', nowMs, quote);
      }
      if (!decision.exit) {
        decision = decideBestOutcomeExit(snap, mid, 'target_time', nowMs, quote);
      }

      const heldBars = i - open.entry_i;
      const forceTime = heldBars >= maxHold;
      if (decision.exit || forceTime) {
        const exitReason = forceTime
          ? `TimeDecay · replay max_hold ${maxHold} bars`
          : decision.reason;
        const pnlPts = favorableMove(open.side, open.entry, mid) - spread;
        trades.push({
          direction: open.side,
          entry_price: open.entry,
          exit_price: mid,
          entry_bar_i: open.entry_i,
          exit_bar_i: i,
          pnl_pts: pnlPts,
          pnl: pnlPts,
          regime: open.regime,
          setup_type: open.setup,
          exit_reason: exitReason,
          epic: 'REPLAY',
          mfe: open.mfe,
          mae: open.mae,
          hold_ms: nowMs - open.entry_at_ms,
        });
        open = null;
      }
      continue;
    }

    const sig = decideEntryWithStructure({
      bar,
      regime: confirmed,
      closedBars: history,
    });
    if (!sig) continue;
    entries += 1;
    const z = zoneGeometry(history, bar);
    open = {
      side: sig.direction,
      entry: mid + (sig.direction === 'BUY' ? spread / 2 : -spread / 2),
      entry_at_ms: nowMs,
      entry_i: i,
      regime: confirmed,
      setup: sig.setup,
      mfe: 0,
      mae: 0,
      peak_retention: null,
      entry_zone: z ? { hi: z.hi, lo: z.lo, mid: z.mid, width: z.width } : null,
      hardinv_breach_since_ms: 0,
      structure_breach_since_ms: 0,
      peak_protect_armed: false,
    };
  }

  return {
    trades,
    expectancy: computeExpectancy(trades, { window: 'replay' }),
    bars: bars.length,
    entries_attempted: entries,
  };
}

/** Build synthetic 10s bars for unit tests (trend then pullback). */
export function syntheticTrendBars(opts?: {
  n?: number;
  start?: number;
  step?: number;
}): TenSecBar[] {
  const n = opts?.n ?? 240;
  const start = opts?.start ?? 2000;
  const step = opts?.step ?? 0.08;
  const out: TenSecBar[] = [];
  let px = start;
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  for (let i = 0; i < n; i++) {
    // Uptrend with occasional dips (every 8th bar)
    const dip = i % 8 === 7;
    const open = px;
    const delta = dip ? -step * 2.5 : step;
    const close = open + delta;
    const high = Math.max(open, close) + step * 0.3;
    const low = Math.min(open, close) - step * 0.3;
    out.push({
      open_time_ms: t0 + i * 10_000,
      open,
      high,
      low,
      close,
      ticks: 12,
    });
    px = close;
  }
  return out;
}

/** Quiet range / chop — small bodies inside a wide zone. */
export function syntheticRangeBars(opts?: {
  n?: number;
  start?: number;
  wobble?: number;
}): TenSecBar[] {
  const n = opts?.n ?? 200;
  const start = opts?.start ?? 4100;
  const wobble = opts?.wobble ?? 0.04;
  const out: TenSecBar[] = [];
  const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);
  for (let i = 0; i < n; i++) {
    const mid = start + Math.sin(i / 7) * wobble * 2;
    const open = mid - wobble * 0.2;
    const close = mid + wobble * 0.2 * (i % 2 === 0 ? 1 : -1);
    out.push({
      open_time_ms: t0 + i * 10_000,
      open,
      high: Math.max(open, close) + wobble * 3,
      low: Math.min(open, close) - wobble * 3,
      close,
      ticks: 8,
    });
  }
  return out;
}

/** Compression then optional expansion impulse. */
export function syntheticCompressionExpansionBars(opts?: {
  n?: number;
  start?: number;
  expand_at?: number;
}): TenSecBar[] {
  const n = opts?.n ?? 200;
  const start = opts?.start ?? 4200;
  const expandAt = opts?.expand_at ?? Math.floor(n * 0.7);
  const out: TenSecBar[] = [];
  const t0 = Date.UTC(2026, 0, 3, 12, 0, 0);
  let px = start;
  for (let i = 0; i < n; i++) {
    const expanding = i >= expandAt;
    const step = expanding ? 0.35 : 0.02;
    const open = px;
    const close = open + (expanding ? step : (i % 2 === 0 ? step : -step));
    const pad = expanding ? step * 0.8 : 0.015;
    out.push({
      open_time_ms: t0 + i * 10_000,
      open,
      high: Math.max(open, close) + pad,
      low: Math.min(open, close) - pad,
      close,
      ticks: 10,
    });
    px = close;
  }
  return out;
}

/** Range then clear breakout pierce. */
export function syntheticBreakoutBars(opts?: {
  n?: number;
  start?: number;
  direction?: 'UP' | 'DOWN';
}): TenSecBar[] {
  const n = opts?.n ?? 200;
  const start = opts?.start ?? 4150;
  const dir = opts?.direction === 'DOWN' ? -1 : 1;
  const out: TenSecBar[] = [];
  const t0 = Date.UTC(2026, 0, 4, 12, 0, 0);
  const breakAt = Math.floor(n * 0.75);
  let px = start;
  for (let i = 0; i < n; i++) {
    const open = px;
    let close: number;
    let high: number;
    let low: number;
    if (i < breakAt) {
      close = open + (i % 2 === 0 ? 0.03 : -0.03);
      high = Math.max(open, close) + 0.8;
      low = Math.min(open, close) - 0.8;
    } else {
      close = open + dir * 0.45;
      high = Math.max(open, close) + 0.2;
      low = Math.min(open, close) - 0.2;
    }
    out.push({
      open_time_ms: t0 + i * 10_000,
      open,
      high,
      low,
      close,
      ticks: 10,
    });
    px = close;
  }
  return out;
}

/** Persistent uptrend tip then violent opposite bar (reversal candidate material). */
export function syntheticReversalBars(opts?: { n?: number; start?: number }): TenSecBar[] {
  const n = opts?.n ?? 180;
  const start = opts?.start ?? 4000;
  const out = syntheticTrendBars({ n: n - 1, start, step: 0.1 });
  const last = out[out.length - 1]!;
  const open = last.close;
  const body = open * 0.0022; // ~0.22% > factory REVERSAL
  const close = open - body;
  out.push({
    open_time_ms: last.open_time_ms + 10_000,
    open,
    high: open + 0.05,
    low: close - 0.25,
    close,
    ticks: 14,
  });
  return out;
}

/** Breakout-up tip then reclaim back into range (failed breakout material). */
export function syntheticFailedBreakoutBars(opts?: { n?: number; start?: number }): TenSecBar[] {
  const n = opts?.n ?? 180;
  const start = opts?.start ?? 4050;
  const out = syntheticBreakoutBars({ n: n - 8, start, direction: 'UP' });
  let px = out[out.length - 1]!.close;
  const t0 = out[out.length - 1]!.open_time_ms;
  for (let i = 0; i < 8; i++) {
    const open = px;
    const close = open - 0.2;
    out.push({
      open_time_ms: t0 + (i + 1) * 10_000,
      open,
      high: open + 0.05,
      low: close - 0.05,
      close,
      ticks: 10,
    });
    px = close;
  }
  return out;
}
