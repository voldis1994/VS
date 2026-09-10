/** Live Capital exit — playbook-specific Best Outcome + thesis. */
import {
  exitParamsForTrade,
  playbookFromRegime,
  thesisFailureForPlaybook,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';

export type ExitSide = 'BUY' | 'SELL';

/**
 * Post-BE early exit (price points, not account currency):
 * - BE zone ≈ Capital floating +£0.00…+£0.01 on ~0.27 Gold (~0.05–0.08pt) → cap 0.12pt
 * - Real profit ≥ 0.45pt → HOLD (PeakProtect/Target on 1m close); never post-BE scratch
 * - After BE-only, exit at −0.35pt — before HardInv ~1.45pt (CONTINUATION)
 */
export const BE_ZONE_ABS = 0.12;
export const PROFIT_HOLD_ABS = 0.45;
export const BE_EARLY_EXIT_ABS = 0.35;
export const BE_EARLY_MIN_HOLD_MS = 8_000;

/**
 * - live_loss: BE fail / HardInv / red thesis — fire on live mark
 * - closed_1m_profit: Target / PeakProtect / TimeDecay — only after Capital 1m close
 * - all: both (unit tests)
 */
export type ExitDecideGate = 'all' | 'live_loss' | 'closed_1m_profit';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  /** Ever saw fav in [0, BE_ZONE_ABS] — flat / +£0.00…+£0.01 class */
  be_seen?: boolean;
  /** Ever saw fav ≥ PROFIT_HOLD_ABS — real green; hold the position */
  profit_seen?: boolean;
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
 *
 * Desk wiring:
 * - live_loss on every quote (wrong side → BE / HardInv)
 * - closed_1m_profit only on new Capital 1m closed candle (plus side → Target / PeakProtect)
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  gate: ExitDecideGate = 'all'
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

  const beSeen = Boolean(s.be_seen) || (mfe > 0 && mfe <= BE_ZONE_ABS);
  const profitSeen = Boolean(s.profit_seen) || mfe >= PROFIT_HOLD_ABS;

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantProfit = gate === 'all' || gate === 'closed_1m_profit';

  if (wantLoss) {
    // 0) Was only BE / +£0.00…+£0.01, then turned red → exit before full HardInv
    if (
      beSeen &&
      !profitSeen &&
      fav <= -BE_EARLY_EXIT_ABS &&
      heldMs >= BE_EARLY_MIN_HOLD_MS
    ) {
      return {
        exit: true,
        reason: `BreakevenFail · ${book} · was BE/flat then UPL ${fav.toFixed(5)} ≤ -${BE_EARLY_EXIT_ABS} (before HardInv ${sl.toFixed(5)})`,
      };
    }

    // 1) HardInv
    if (fav <= -sl) {
      return {
        exit: true,
        reason: `HardInvalidation · ${book} · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
      };
    }

    // 2) Thesis only when underwater
    const thesisRegime = s.entry_regime ?? s.regime;
    if (thesisRegime) {
      const thesis = thesisFailureForPlaybook(s.open_side, thesisRegime, book);
      if (thesis && heldMs >= p.thesisMinHoldMs && fav <= 0) {
        return { exit: true, reason: `${thesis} · ${book} · ${s.entry_setup || 'setup?'}` };
      }
    }
  }

  if (wantProfit) {
    // 3) Target — bank TP on closed 1m only (desk gate)
    if (fav >= tp) {
      return {
        exit: true,
        reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)} · 1mClose`,
      };
    }

    // 4) PeakProtect
    if (mfe >= mfeFloor && fav > 0 && retention != null && retention < p.peakRet) {
      return {
        exit: true,
        reason: `PeakProtection · ${book} · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · 1mClose`,
      };
    }

    // 5) TimeDecay — green/flat chop with no real MFE
    if (heldMs > p.timeDecayMs && fav >= 0 && mfe < mfeFloor) {
      return {
        exit: true,
        reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)} · 1mClose`,
      };
    }
  }

  return { exit: false, reason: '' };
}
