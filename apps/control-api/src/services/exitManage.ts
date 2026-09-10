/** Live Capital exit — playbook-specific Best Outcome + thesis. */
import {
  exitParamsForTrade,
  playbookFromRegime,
  thesisFailureForPlaybook,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  /** Live diagnostic 10s label — NOT used for thesis while entry_regime is locked */
  regime?: string | null;
  /** Regime frozen at fill — only thesis input (no flicker scratches) */
  entry_regime?: string | null;
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
  const fromRegime = playbookFromRegime(s.entry_regime || s.regime);
  if (fromRegime === 'WAIT') return 'SCALP';
  return fromRegime;
}

/**
 * Manage exit divided by playbook (LONG / SCALP / FADE).
 * Broker SAFETY SL remains the hard cushion outside this function.
 *
 * Order: HardInv → thesis (locked entry_regime, red only) → Target → PeakProtect 75%.
 * Target before PeakProtect so runners that hit TP bank the target instead of giveback-exit.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const book = resolvePlaybook(s);
  const p = exitParamsForTrade(book, s.entry_setup);
  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const tp = Math.max(absEntry * p.tpPct, p.tpFloor);
  const sl = Math.min(Math.max(absEntry * p.slPct, p.slFloor), p.slCapAbs);
  const mfeFloor = Math.max(absEntry * p.mfeFloorPct, p.mfeFloorAbs);
  const mfe = Math.max(s.mfe, Math.max(0, fav));
  const retention = mfe > 0 ? Math.max(0, fav / mfe) : null;

  // 1) Losers first — tight capped HardInv
  if (fav <= -sl) {
    return {
      exit: true,
      reason: `HardInvalidation · ${book} · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
    };
  }

  // 2) Thesis only when underwater + prefer regime locked at entry (desk freezes it)
  const thesisRegime = s.entry_regime ?? s.regime;
  if (thesisRegime) {
    const thesis = thesisFailureForPlaybook(s.open_side, thesisRegime, book);
    if (thesis && heldMs >= p.thesisMinHoldMs && fav <= 0) {
      return { exit: true, reason: `${thesis} · ${book} · ${s.entry_setup || 'setup?'}` };
    }
  }

  // 3) Target first — bank TP when reached (before giveback logic)
  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  // 4) PeakProtect — max 25% giveback while still green and below TP
  if (mfe >= mfeFloor && fav > 0 && retention != null && retention < p.peakRet) {
    return {
      exit: true,
      reason: `PeakProtection · ${book} · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)}`,
    };
  }

  // 5) TimeDecay — only when never built a real MFE leg
  if (heldMs > p.timeDecayMs && fav >= 0 && mfe < mfeFloor) {
    return {
      exit: true,
      reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}
