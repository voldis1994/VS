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
 * - Hold green while move still live (≥55% of MFE kept)
 * - Trail / bank only after a real protected run (~0.9pt Gold), not +0.05 blips
 * - Cut underwater early after a protected run (do not ride to full SL)
 * - Decisions use closeable bid/ask so spread cannot turn green mid into red close
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

  // Arm trail/giveback only after a real run — not on +£0.05 noise
  // US100 @ ~29k: 0.9 Gold-pts ≈ 5.9 index pts — enough to ignore spread noise
  const protectAfterMfe = Math.max(scaleFromGold(absEntry, 0.9), absEntry * 0.00018);
  const hadProtectedRun = s.mfe >= protectAfterMfe;
  const minProfitExit = Math.max(scaleFromGold(absEntry, 0.35), absEntry * 0.00004);
  // Keep ≥70% of peak — +0.43 → +0.18 (~42%) is not acceptable
  const keepFrac = Math.max(p.peakRet, 0.7);
  const givebackFloor = Math.max(minProfitExit, s.mfe * keepFrac);
  const peakMinHoldMs = legRide ? 8_000 : Math.min(p.thesisMinHoldMs * 0.35, 20_000);

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
  if (hadProtectedRun && fav < 0 && heldMs >= 8_000) {
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

  const thesis = thesisFailureForPlaybook(s.open_side, s.regime, book);
  if (thesis && heldMs >= p.thesisMinHoldMs) {
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

  // Fav-based trail when retention missing / lagging — lock ≥70% of MFE
  if (
    hadProtectedRun &&
    fav >= 0 &&
    fav < givebackFloor &&
    heldMs >= 8_000 &&
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
