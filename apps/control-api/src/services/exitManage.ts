/** Live Capital exit — playbook Best Outcome + unified MarketBrain dynamics. */
import {
  exitParamsForTrade,
  isLegRideSetup,
  playbookFromRegime,
  thesisFailureForPlaybook,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';
import { scaleFromGold } from './instrumentScale.js';
import {
  brainExitParams,
  brainExitThesis,
  type BrainState,
  type LockedBrainEntry,
} from './marketBrain.js';

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
  const brain = s.brain?.ready ? s.brain : null;
  const dynamic =
    brain != null
      ? brainExitParams(brain, s.brain_locked ?? null, quote.mid, s.open_side)
      : null;

  const peakRet = dynamic?.peakRet ?? p.peakRet;
  const harvestRet = dynamic?.harvestRet ?? p.harvestRet;
  const timeDecayMs = dynamic ? p.timeDecayMs * dynamic.timeDecayScale : p.timeDecayMs;

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  const legRide = isLegRideSetup(s.entry_setup);

  const entry = s.entry_price;
  const fav = executableFavorableMove(s.open_side, entry, quote);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const minProfitExit = legRide
    ? Math.max(scaleFromGold(absEntry, 0.4), absEntry * 0.00004)
    : Math.max(scaleFromGold(absEntry, 0.25), absEntry * 0.00002);

  const sl = Math.max(absEntry * p.slPct, p.slFloor);
  const mfeFloor = Math.max(absEntry * p.mfeFloorPct, p.mfeFloorAbs);
  const peakMinHoldMs = legRide ? 45_000 : Math.min(p.thesisMinHoldMs * 0.5, 60_000);
  const pressureMinMfe = Math.max(
    mfeFloor,
    legRide ? scaleFromGold(absEntry, 1.8) : scaleFromGold(absEntry, 1.0)
  );
  const givebackRet = legRide ? 0.5 : 0.55;
  const hadProvenRun = s.mfe >= pressureMinMfe;

  if (fav <= -sl) {
    return {
      exit: true,
      reason: `HardInvalidation · ${book} · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
    };
  }

  // Had real profit, now underwater — cut reversal before riding to full SL (4329→4318 class)
  if (
    hadProvenRun &&
    fav < 0 &&
    heldMs >= Math.min(peakMinHoldMs, 60_000)
  ) {
    return {
      exit: true,
      reason: `ReversalStop · ${book} · had MFE ${s.mfe.toFixed(5)} now ${fav.toFixed(5)} · closeable loss capped`,
    };
  }

  // Gave back half the leg while still green — bank it (do not wait for BE)
  if (
    hadProvenRun &&
    fav >= 0 &&
    s.peak_retention != null &&
    s.peak_retention < givebackRet &&
    heldMs >= Math.min(peakMinHoldMs, 45_000)
  ) {
    return {
      exit: true,
      reason: `ProfitGiveback · ${book} · kept ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · closeable ${fav.toFixed(5)}`,
    };
  }

  const brainThesis =
    brain != null ? brainExitThesis(brain, s.open_side, book, s.entry_setup) : null;
  const brainThesisHold = legRide ? p.thesisMinHoldMs : p.thesisMinHoldMs * 0.85;
  if (brainThesis && heldMs >= brainThesisHold) {
    if (!legRide || fav >= 0 || hadProvenRun) {
      return { exit: true, reason: `${brainThesis} · ${book}` };
    }
  }

  const thesis = thesisFailureForPlaybook(s.open_side, s.regime, book, s.entry_setup);
  if (thesis && heldMs >= p.thesisMinHoldMs) {
    return { exit: true, reason: `${thesis} · ${book} · ${s.entry_setup || 'setup?'}` };
  }

  let tp = Math.max(absEntry * p.tpPct, p.tpFloor);
  if (dynamic?.tpDistance != null && dynamic.tpDistance > 0) {
    tp = Math.max(tp, dynamic.tpDistance);
  }

  if (
    heldMs >= peakMinHoldMs &&
    hadProvenRun &&
    fav >= minProfitExit &&
    s.peak_retention != null &&
    s.peak_retention < peakRet
  ) {
    return {
      exit: true,
      reason: `PeakProtection · ${book} · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · closeable ${fav.toFixed(5)}${brain ? ` · ${brain.move_state}` : ''}`,
    };
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}${brain ? ` · brain ${brain.move_state}` : ''}`,
    };
  }

  if (
    hadProvenRun &&
    fav >= minProfitExit &&
    s.peak_retention != null &&
    s.peak_retention < harvestRet &&
    s.peak_retention >= peakRet &&
    s.mfe - fav >= Math.max(pressureMinMfe * 0.35, absEntry * 0.0005)
  ) {
    return {
      exit: true,
      reason: `BestOutcome harvest · ${book} · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const moveStillLive =
    fav > 0 &&
    s.peak_retention != null &&
    s.peak_retention >= 0.35 &&
    fav >= s.mfe * 0.45;

  const hadRealRun = s.mfe >= mfeFloor;
  const timeDecayMinFav = hadRealRun ? 0 : -mfeFloor * 0.2;

  if (
    heldMs > timeDecayMs &&
    !moveStillLive &&
    fav >= timeDecayMinFav &&
    s.mfe >= mfeFloor * 0.5
  ) {
    return {
      exit: true,
      reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)}${brain?.move_state === 'EXHAUSTING' ? ' · exhausting' : ''}`,
    };
  }

  return { exit: false, reason: '' };
}
