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
 * Soft loss exits use HardInv only (no BreakevenFail scratch path).
 * PeakProtect / Target bank green on live mark.
 */
export const BE_ZONE_ABS = 0.12; // diagnostic only — no longer triggers early exit
export const PROFIT_HOLD_ABS = 0.45;
/** @deprecated BreakevenFail disabled — kept for imports */
export const BE_EARLY_EXIT_ABS = 0.35;
export const BE_EARLY_MIN_HOLD_MS = 8_000;

/**
 * - live_loss: BE fail / HardInv / red thesis — fire on live mark
 * - live_profit: Target / PeakProtect / TimeDecay — fire on live mark (bank green before giveback)
 * - closed_1m_profit: alias of live_profit (legacy desk/tests)
 * - all: both
 */
export type ExitDecideGate = 'all' | 'live_loss' | 'live_profit' | 'closed_1m_profit';

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

/**
 * After HardInvalidation: opposite side for a one-shot SCALP (catch the move).
 * No chain: if the closed trade was already HARDINV_FLIP, return null.
 */
export function hardInvOppositeScalpSide(
  reason: string,
  closedSide: ExitSide | null | undefined,
  entrySetup?: string | null
): ExitSide | null {
  if (!closedSide || !/HardInvalidation/i.test(reason)) return null;
  if (String(entrySetup || '').toUpperCase() === 'HARDINV_FLIP') return null;
  return closedSide === 'BUY' ? 'SELL' : 'BUY';
}

/**
 * After HardInv close Capital often still lists the old leg for a few hundred ms.
 * Flip must not re-adopt that ghost (would block opposite SCALP) and must not
 * wait for a 1m candle — only for broker clear / opposite fill.
 */
export function hardInvFlipBrokerAction(
  pendingSide: ExitSide | null | undefined,
  brokerSide: ExitSide | null | undefined
): 'enter' | 'wait_clear' | 'adopt_flip' | 'none' {
  if (!pendingSide) return 'none';
  if (!brokerSide) return 'enter';
  if (brokerSide === pendingSide) return 'adopt_flip';
  return 'wait_clear';
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
 * Desk wiring: every manage tick uses live mark for BOTH loss and profit
 * (PeakProtect must bank green before the move flips to red).
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

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantProfit =
    gate === 'all' || gate === 'live_profit' || gate === 'closed_1m_profit';

  if (wantLoss) {
    // 1) HardInv only — BreakevenFail disabled (user: no more BE scratch exits)
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
    // 3) Target — bank TP on LIVE mark
    if (fav >= tp) {
      return {
        exit: true,
        reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)} · live`,
      };
    }

    // 4) PeakProtect — LIVE so giveback cannot ride to red
    if (mfe >= mfeFloor && fav > 0 && retention != null && retention < p.peakRet) {
      return {
        exit: true,
        reason: `PeakProtection · ${book} · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · live`,
      };
    }

    // 5) TimeDecay — green/flat chop with no real MFE
    if (heldMs > p.timeDecayMs && fav >= 0 && mfe < mfeFloor) {
      return {
        exit: true,
        reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)} · live`,
      };
    }
  }

  return { exit: false, reason: '' };
}
