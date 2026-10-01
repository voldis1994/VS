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
