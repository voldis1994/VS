/**
 * Unified manage exit — one pipeline for open trades.
 *
 * Priority:
 *  1) HardInv (−SL)
 *  2) Profit lock (price PeakProtection / TP / harvest / broker £ peak — NOT BE chop)
 *  3) When red only: TapeExit (dump vs BUY, rally vs SELL) + ThesisFailure
 *
 * Entry bloķēšana / Capital hedge are separate — never block step 2 on open trades.
 */

import { tapeMoveShouldExit } from './deskSideLock.js';

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
  short_net_pct?: number | null;
  atr?: number | null;
  structural_sl?: number | null;
  structure_target?: number | null;
  tick_size?: number | null;
  broker_upl?: number | null;
  /** Session peak broker £ — for partial lock, not full GivebackBE */
  broker_peak_upl?: number | null;
  spread?: number | null;
};

export const BO_SL_PCT = 0.0022;
export const BO_SL_MIN = 0.22;
export const BO_TP_SL_RATIO = 0.65;
export const BO_TP_PCT = 0.0012;
export const BO_TP_MIN = 0.35;
export const BO_PEAK_PROTECT_RETENTION = 0.3;
export const BO_HARVEST_RETENTION = 0.4;
export const BO_TIME_DECAY_MS = 480_000;
export const BO_BROKER_PEAK_MIN = 0.12;
export const BO_BROKER_RETAIN = 0.5;

export type ManageExitContext = {
  shortNetPct?: number | null;
  /** Tape-aware regime for thesis when red (else snapshot.regime) */
  exitRegime?: string | null;
};

export type BoExitOpts = ManageExitContext;

type BoMeta = { tick_size?: number | null };

export function favorableMove(side: ExitSide, entry: number, px: number): number {
  return side === 'BUY' ? px - entry : entry - px;
}

export function manageExitPrice(
  side: ExitSide,
  quote: { bid?: number | null; ask?: number | null; mid?: number | null }
): number | null {
  if (side === 'BUY') {
    if (quote.bid != null && Number.isFinite(quote.bid)) return quote.bid;
  } else {
    if (quote.ask != null && Number.isFinite(quote.ask)) return quote.ask;
  }
  if (quote.mid != null && Number.isFinite(quote.mid)) return quote.mid;
  return null;
}

export function boSlDistance(entry: number): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  return Math.max(absEntry * BO_SL_PCT, BO_SL_MIN);
}

/** Tick-based floor — micro Gold wins (+0.86pt) arm PeakProtection (not 5.6pt pct wall). */
export function boMfeFloor(entry: number, meta?: BoMeta): number {
  const tick = meta?.tick_size;
  const tickFloor = tick != null && Number.isFinite(tick) && tick > 0 ? tick * 2 : 0.12;
  return Math.max(tickFloor, 0.08);
}

/** TP tied to SL — take plus as readily as minus stops. */
export function boTpDistance(entry: number, meta?: BoMeta): number {
  const sl = boSlDistance(entry);
  const pctTp = Math.max(Math.abs(entry) * BO_TP_PCT, BO_TP_MIN);
  const floor = boMfeFloor(entry, meta);
  return Math.max(Math.min(pctTp, sl * BO_TP_SL_RATIO), floor * 1.5);
}

export function thesisFailureReason(
  side: ExitSide,
  regime?: string | null
): string | null {
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (!r || r === 'UNKNOWN') return null;
  if (side === 'BUY') {
    if (
      r === 'TREND_DOWN' ||
      r === 'BREAKOUT_DOWN' ||
      r === 'PULLBACK_DOWNTREND' ||
      r === 'FAILED_BREAKOUT_UP'
    ) {
      return `ThesisFailure · BUY vs ${r}`;
    }
  } else if (
    r === 'TREND_UP' ||
    r === 'BREAKOUT_UP' ||
    r === 'PULLBACK_UPTREND' ||
    r === 'FAILED_BREAKOUT_DOWN'
  ) {
    return `ThesisFailure · SELL vs ${r}`;
  }
  return null;
}

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|ThesisFailure|TapeExit|PeakProtection|BrokerPeakLock|Target \/|BestOutcome harvest|TimeDecay/i.test(
    reason
  );
}

export function shouldBrokerPeakLock(
  s: ExitSnapshot,
  fav: number,
  hitEps: number
): { exit: boolean; reason: string } {
  const peak = s.broker_peak_upl;
  const cur = s.broker_upl;
  if (peak == null || cur == null || !(peak + hitEps >= BO_BROKER_PEAK_MIN)) {
    return { exit: false, reason: '' };
  }
  if (cur + hitEps <= 0 || fav + hitEps <= 0) {
    return { exit: false, reason: '' };
  }
  const minLockGbp = Math.max(BO_BROKER_PEAK_MIN * 0.45, 0.05);
  if (cur + hitEps < minLockGbp) {
    return { exit: false, reason: '' };
  }
  if (cur + hitEps < peak * BO_BROKER_RETAIN) {
    return {
      exit: true,
      reason: `BrokerPeakLock · £ ${cur.toFixed(2)} < ${(BO_BROKER_RETAIN * 100).toFixed(0)}% of peak £${peak.toFixed(2)} · lock partial profit`,
    };
  }
  return { exit: false, reason: '' };
}

/** Price + broker profit exits (no tape/thesis). */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  exitPx: number,
  _opts?: BoExitOpts
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const meta: BoMeta = { tick_size: s.tick_size };
  const fav = favorableMove(s.open_side, entry, exitPx);
  const hitEps = Math.max(Math.abs(entry) * 1e-12, 1e-9);
  const tp = boTpDistance(entry, meta);
  const sl = boSlDistance(entry);
  const mfeFloor = boMfeFloor(entry, meta);

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  const brokerLock = shouldBrokerPeakLock(s, fav, hitEps);
  if (brokerLock.exit) return brokerLock;

  if (
    s.mfe + hitEps >= mfeFloor &&
    s.peak_retention != null &&
    s.peak_retention + hitEps < BO_PEAK_PROTECT_RETENTION
  ) {
    return {
      exit: true,
      reason: `PeakProtection · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · floor ${mfeFloor.toFixed(5)} → lock best`,
    };
  }

  if (fav + hitEps >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (
    s.mfe + hitEps >= mfeFloor &&
    fav > hitEps &&
    s.peak_retention != null &&
    s.peak_retention + hitEps < BO_HARVEST_RETENTION
  ) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > BO_TIME_DECAY_MS && fav + hitEps >= 0 && s.mfe + hitEps >= mfeFloor * 0.5) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize non-negative best UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}

/** Full open-trade exit — BO profit first, tape/thesis only when red. */
export function decideManageExit(
  s: ExitSnapshot,
  exitPx: number,
  ctx?: ManageExitContext
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const bo = decideBestOutcomeExit(s, exitPx);
  if (bo.exit) return bo;

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, exitPx);
  const hitEps = Math.max(Math.abs(entry) * 1e-12, 1e-9);

  if (fav + hitEps > 0) {
    return { exit: false, reason: '' };
  }

  const shortNet = ctx?.shortNetPct ?? s.short_net_pct;
  const tape = tapeMoveShouldExit(s.open_side, shortNet, fav);
  if (tape.exit) return tape;

  const regime = ctx?.exitRegime ?? s.regime;
  const thesis = thesisFailureReason(s.open_side, regime);
  if (thesis) return { exit: true, reason: thesis };

  return { exit: false, reason: '' };
}

export function describeBestOutcomeState(
  s: ExitSnapshot,
  exitPx: number,
  _opts?: BoExitOpts & { continuationReason?: string }
): { exit: boolean; reason: string; hold: string } {
  const decision = decideManageExit(s, exitPx);
  if (decision.exit) return { ...decision, hold: '' };

  if (!s.open_side || s.entry_price == null) {
    return { exit: false, reason: '', hold: 'BO blocked — missing entry_price' };
  }

  const entry = s.entry_price;
  const meta: BoMeta = { tick_size: s.tick_size };
  const fav = favorableMove(s.open_side, entry, exitPx);
  const tp = boTpDistance(entry, meta);
  const sl = boSlDistance(entry);
  const mfeFloor = boMfeFloor(entry, meta);
  const peakBroker = s.broker_peak_upl;

  return {
    exit: false,
    reason: '',
    hold: `BO HOLD · UPL ${fav.toFixed(2)} · peak MFE ${s.mfe.toFixed(2)} · TP ${tp.toFixed(2)} · SL ${sl.toFixed(2)} · floor ${mfeFloor.toFixed(2)} · ret ${
      s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—'
    }${peakBroker != null ? ` · peak£ ${peakBroker.toFixed(2)}` : ''}`,
  };
}
