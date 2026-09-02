/** Live Capital exit — hold live wins, cut failed runs early; use closeable bid/ask. */
import {
  exitParamsForTrade,
  playbookFromRegime,
  thesisFailureForPlaybook,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';
import { scaleFromGold } from './instrumentScale.js';

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
  /** Locked at entry — drives exit policy */
  playbook?: Playbook | null;
  /** Locked setup kind at entry — CONTINUATION/PULLBACK/FADE tune hold vs scalp */
  entry_setup?: string | null;
  /** Live 1m flow — preferred thesis for legs (not flickering 10s regime) */
  flow_bias?: 'UP' | 'DOWN' | null;
  /** Clear V-flip at fresh extreme — exit NOW and reverse (not 4min thesis) */
  flow_flip?: 'UP' | 'DOWN' | null;
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

function asQuote(midOrQuote: number | ExitQuote): ExitQuote {
  if (typeof midOrQuote === 'number') return { mid: midOrQuote };
  return midOrQuote;
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

function isLegRide(setup?: string | null): boolean {
  const s = String(setup || '').trim().toUpperCase();
  return s === 'CONTINUATION' || s === 'PULLBACK' || s === 'BREAKOUT';
}

/**
 * Manage exit divided by playbook (LONG / SCALP / FADE).
 * Micro-swing legs (CONTINUATION/BREAKOUT/PULLBACK): hold the 1m move —
 * trail only after a real run, not 2s blips.
 * Decisions use closeable bid/ask so spread cannot turn green mid into red close.
 * Broker SAFETY SL remains the hard cushion outside this function.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  midOrQuote: number | ExitQuote
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const quote = asQuote(midOrQuote);
  const book = resolvePlaybook(s);
  const p = exitParamsForTrade(book, s.entry_setup, s.entry_price);
  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  const legRide = isLegRide(s.entry_setup);

  const entry = s.entry_price;
  const fav = executableFavorableMove(s.open_side, entry, quote);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const tp = Math.max(absEntry * p.tpPct, p.tpFloor);
  const sl = Math.max(absEntry * p.slPct, p.slFloor);
  const mfeFloor = Math.max(absEntry * p.mfeFloorPct, p.mfeFloorAbs);

  // Arm trail/giveback only after a real 1m-scale run (legs) — not +£0.05 / 2s noise
  const protectAfterMfe = legRide
    ? Math.max(scaleFromGold(absEntry, 2.0), absEntry * 0.0004)
    : Math.max(scaleFromGold(absEntry, 0.9), absEntry * 0.00018);
  const hadProtectedRun = s.mfe >= protectAfterMfe;
  const minProfitExit = Math.max(scaleFromGold(absEntry, 0.35), absEntry * 0.00004);
  // Keep ≥65% of peak — max 35% giveback
  const keepFrac = Math.max(p.peakRet, 0.65);
  const givebackFloor = Math.max(minProfitExit, s.mfe * keepFrac);
  // Micro-swing: do not PeakProtect / giveback in the first ~60s of a leg
  const peakMinHoldMs = legRide ? 60_000 : Math.min(p.thesisMinHoldMs * 0.35, 20_000);

  const moveStillLive =
    fav > 0 &&
    s.peak_retention != null &&
    s.peak_retention >= keepFrac &&
    fav >= s.mfe * keepFrac;

  if (fav <= -sl) {
    return {
      exit: true,
      reason: `HardInvalidation · ${book} · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
    };
  }

  // Had real profit, now underwater — cut before full SL
  if (hadProtectedRun && fav < 0 && heldMs >= (legRide ? 15_000 : 8_000)) {
    return {
      exit: true,
      reason: `ReversalStop · ${book} · had MFE ${s.mfe.toFixed(5)} now ${fav.toFixed(5)} · loss capped`,
    };
  }

  // Never printed a real run, but deep red — soft cut at ~55% of SL (do not wait for max)
  const softSl = sl * 0.55;
  if (!hadProtectedRun && fav <= -softSl && heldMs >= 25_000) {
    return {
      exit: true,
      reason: `EarlyCut · ${book} · UPL ${fav.toFixed(5)} ≤ -softSL ${softSl.toFixed(5)} · no protected MFE`,
    };
  }

  // V-flip at fresh extreme against the open leg — cut NOW (screenshot 20:00 class).
  // Do not wait CONTINUATION thesisMinHold 240s while price already ran the other way.
  if (legRide && s.flow_flip && heldMs >= 12_000) {
    if (s.open_side === 'BUY' && s.flow_flip === 'DOWN') {
      return {
        exit: true,
        reason: `MoveFlip · BUY vs V-flip DOWN · ${s.entry_setup || 'leg'}`,
      };
    }
    if (s.open_side === 'SELL' && s.flow_flip === 'UP') {
      return {
        exit: true,
        reason: `MoveFlip · SELL vs V-flip UP · ${s.entry_setup || 'leg'}`,
      };
    }
  }

  const thesis = (() => {
    // Micro-swing legs: thesis from 1m flow against the trade — not diagnostic 10s regime flips
    if (legRide && s.flow_bias) {
      if (s.open_side === 'BUY' && s.flow_bias === 'DOWN') {
        return `ThesisFailure · leg BUY vs 1m flow DOWN`;
      }
      if (s.open_side === 'SELL' && s.flow_bias === 'UP') {
        return `ThesisFailure · leg SELL vs 1m flow UP`;
      }
      return null;
    }
    return thesisFailureForPlaybook(s.open_side, s.regime, book);
  })();
  // Against-flow legs: max 45s — 240s thesis was the "can't switch" lag
  const againstFlow =
    legRide &&
    !!s.flow_bias &&
    ((s.open_side === 'BUY' && s.flow_bias === 'DOWN') ||
      (s.open_side === 'SELL' && s.flow_bias === 'UP'));
  const thesisHold = againstFlow ? Math.min(p.thesisMinHoldMs, 45_000) : p.thesisMinHoldMs;
  if (thesis && heldMs >= thesisHold) {
    return { exit: true, reason: `${thesis} · ${book} · ${s.entry_setup || 'setup?'}` };
  }

  // Never PeakProtect / harvest into a red closeable P&L
  if (
    heldMs >= peakMinHoldMs &&
    hadProtectedRun &&
    fav >= 0 &&
    s.peak_retention != null &&
    s.peak_retention < p.peakRet
  ) {
    return {
      exit: true,
      reason: `PeakProtection · ${book} · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)}`,
    };
  }

  // Fav-based trail when retention missing / lagging — lock ≥65% of MFE
  if (
    hadProtectedRun &&
    fav >= 0 &&
    fav < givebackFloor &&
    heldMs >= peakMinHoldMs &&
    (s.peak_retention == null || s.peak_retention < keepFrac)
  ) {
    return {
      exit: true,
      reason: `ProfitGiveback · ${book} · floor ${givebackFloor.toFixed(5)} of MFE ${s.mfe.toFixed(5)} · closeable ${fav.toFixed(5)}`,
    };
  }

  // Hit TP — but if move still live, ride (extended target only)
  if (fav >= tp && (!moveStillLive || fav >= tp * 1.25)) {
    return {
      exit: true,
      reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (
    hadProtectedRun &&
    !moveStillLive &&
    fav > 0 &&
    heldMs >= peakMinHoldMs &&
    s.peak_retention != null &&
    s.peak_retention < p.harvestRet &&
    s.peak_retention >= p.peakRet
  ) {
    return {
      exit: true,
      reason: `BestOutcome harvest · ${book} · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  if (
    heldMs > p.timeDecayMs &&
    !moveStillLive &&
    fav >= 0 &&
    s.mfe >= Math.min(mfeFloor, protectAfterMfe) * 0.5
  ) {
    return {
      exit: true,
      reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}
