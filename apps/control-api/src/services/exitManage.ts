/** Live Capital exit — playbook Best Outcome (brain is advisory UI only). */
import {
  exitParamsForTrade,
  isLegRideSetup,
  playbookFromRegime,
  thesisFailureForPlaybook,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';
import { scaleFromGold } from './instrumentScale.js';
import type { BrainState, LockedBrainEntry } from './marketBrain.js';

export type ExitSide = 'BUY' | 'SELL';

export type ExitQuote = {
  mid: number;
  bid?: number | null;
  ask?: number | null;
};

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
  playbook?: Playbook | null;
  entry_setup?: string | null;
  /** Live MarketBrain — dynamic TP / survival / exhaustion */
  brain?: BrainState | null;
  /** Snapshot locked at entry */
  brain_locked?: LockedBrainEntry | null;
};

/** @deprecated use playbook thesisMinHold — kept for tests importing name */
export const THESIS_MIN_HOLD_MS = 60_000;

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

/** Closeable P&L — BUY exits at bid, SELL exits at ask (not mid). */
export function executableFavorableMove(
  side: ExitSide,
  entry: number,
  quote: ExitQuote
): number {
  const px =
    side === 'BUY'
      ? quote.bid != null && Number.isFinite(quote.bid)
        ? quote.bid
        : quote.mid
      : quote.ask != null && Number.isFinite(quote.ask)
        ? quote.ask
        : quote.mid;
  return favorableMove(side, entry, px);
}

/** Legacy helper — SCALP-style list; prefer thesisFailureForPlaybook. */
export function thesisFailureReason(
  side: ExitSide,
  regime?: string | null
): string | null {
  return thesisFailureForPlaybook(side, regime, 'SCALP');
}

function resolvePlaybook(s: ExitSnapshot): TradePlaybook {
  const p = s.playbook;
  if (p === 'LONG' || p === 'SCALP' || p === 'FADE') return p;
  const fromRegime = playbookFromRegime(s.regime);
  if (fromRegime === 'WAIT') return 'SCALP';
  return fromRegime;
}

/**
 * Manage exit: playbook floors + MarketBrain dynamic targets when available.
 * Broker SAFETY SL remains the hard cushion outside this function.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  quote: ExitQuote
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const book = resolvePlaybook(s);
  const p = exitParamsForTrade(book, s.entry_setup, s.entry_price);
  // Brain is advisory (UI / labels only) — exits follow playbook trail, not brain TP/thesis
  const peakRet = p.peakRet;
  const harvestRet = p.harvestRet;
  const timeDecayMs = p.timeDecayMs;

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  const legRide = isLegRideSetup(s.entry_setup);

  const entry = s.entry_price;
  const fav = executableFavorableMove(s.open_side, entry, quote);
  const midFav = favorableMove(s.open_side, entry, quote.mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const minProfitExit = Math.max(scaleFromGold(absEntry, 0.35), absEntry * 0.00004);

  const sl = Math.max(absEntry * p.slPct, p.slFloor);
  const mfeFloor = Math.max(absEntry * p.mfeFloorPct, p.mfeFloorAbs);
  const peakMinHoldMs = legRide ? 30_000 : Math.min(p.thesisMinHoldMs * 0.5, 45_000);
  const pressureMinMfe = Math.max(
    scaleFromGold(absEntry, legRide ? 1.5 : 1.0),
    absEntry * 0.00025
  );
  const protectAfterMfe = Math.max(scaleFromGold(absEntry, 0.9), absEntry * 0.00018);
  const hadProtectedRun = s.mfe >= protectAfterMfe;
  const hadProvenRun = s.mfe >= pressureMinMfe;
  const givebackFloor = Math.max(minProfitExit, s.mfe * 0.55);

  if (fav <= -sl) {
    return {
      exit: true,
      reason: `HardInvalidation · ${book} · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
    };
  }

  if (hadProtectedRun && fav < 0 && heldMs >= 8_000) {
    return {
      exit: true,
      reason: `ReversalStop · ${book} · had MFE ${s.mfe.toFixed(5)} now ${fav.toFixed(5)} · closeable loss capped`,
    };
  }

  if (
    hadProtectedRun &&
    fav >= 0 &&
    fav < givebackFloor &&
    heldMs >= 12_000
  ) {
    return {
      exit: true,
      reason: `ProfitGiveback · ${book} · floor ${givebackFloor.toFixed(5)} of MFE ${s.mfe.toFixed(5)} · closeable ${fav.toFixed(5)}`,
    };
  }

  if (
    hadProtectedRun &&
    midFav >= givebackFloor &&
    fav < givebackFloor &&
    fav >= 0 &&
    heldMs >= 12_000
  ) {
    return {
      exit: true,
      reason: `ProfitGiveback · ${book} · mid ${midFav.toFixed(5)} vs bid floor · closeable ${fav.toFixed(5)}`,
    };
  }

  const thesis = thesisFailureForPlaybook(s.open_side, s.regime, book, s.entry_setup);
  if (thesis && heldMs >= p.thesisMinHoldMs) {
    return { exit: true, reason: `${thesis} · ${book} · ${s.entry_setup || 'setup?'}` };
  }

  const tp = Math.max(absEntry * p.tpPct, p.tpFloor);

  if (
    heldMs >= peakMinHoldMs &&
    hadProvenRun &&
    fav >= minProfitExit &&
    s.peak_retention != null &&
    s.peak_retention < peakRet
  ) {
    return {
      exit: true,
      reason: `PeakProtection · ${book} · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · closeable ${fav.toFixed(5)}`,
    };
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (
    hadProvenRun &&
    fav >= minProfitExit &&
    s.peak_retention != null &&
    s.peak_retention < harvestRet &&
    s.peak_retention >= peakRet &&
    s.mfe - fav >= Math.max(pressureMinMfe * 0.3, absEntry * 0.0004)
  ) {
    return {
      exit: true,
      reason: `BestOutcome harvest · ${book} · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const moveStillLive =
    fav > 0 &&
    s.peak_retention != null &&
    s.peak_retention >= 0.4 &&
    fav >= s.mfe * 0.5;

  const hadRealRun = s.mfe >= protectAfterMfe;
  const timeDecayMinFav = hadRealRun ? minProfitExit : -mfeFloor * 0.2;

  if (
    heldMs > timeDecayMs &&
    !moveStillLive &&
    fav >= timeDecayMinFav &&
    s.mfe >= protectAfterMfe * 0.5
  ) {
    return {
      exit: true,
      reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}
