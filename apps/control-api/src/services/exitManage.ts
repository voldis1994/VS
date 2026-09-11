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

/** Mark for HardInv: BUY uses bid, SELL uses ask — fire before broker SL. */
export function adverseMark(
  side: ExitSide,
  bid: number | null | undefined,
  ask: number | null | undefined,
  mid: number
): number {
  if (side === 'BUY' && bid != null && Number.isFinite(bid)) return bid;
  if (side === 'SELL' && ask != null && Number.isFinite(ask)) return ask;
  return mid;
}


export type CandleOHLC = { open: number; close: number };

export type MinuteDir = 'UP' | 'DOWN' | 'FLAT';

/** Live MFE (pts) that arms PeakProtect on the desk — all books. */
export const PEAK_PROTECT_ARM_MFE = 1.5;

/** Arm PeakProtect as soon as live MFE reaches floor (no 1m candle wait). */
export function shouldArmPeakProtect(
  mfe: number,
  alreadyArmed: boolean,
  floor = PEAK_PROTECT_ARM_MFE
): boolean {
  return !alreadyArmed && Number.isFinite(mfe) && mfe >= floor;
}

/**
 * Desk gates:
 * - live_loss: HardInv 1.5pt ONLY — fire on live mark (NO thesis scratch)
 * - peak_protect_only: PeakProtect giveback only (armed live at MFE ≥ 1.5pt)
 * - closed_1m_profit / live_profit: legacy full profit suite (not used by desk manage)
 * - all: both loss + full profit (tests / fallback)
 */
export type ExitDecideGate =
  | 'all'
  | 'live_loss'
  | 'live_profit'
  | 'closed_1m_profit'
  | 'peak_protect_only';

export function minuteCandleDir(c: CandleOHLC): MinuteDir {
  if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return 'FLAT';
  if (c.close > c.open) return 'UP';
  if (c.close < c.open) return 'DOWN';
  return 'FLAT';
}

/** Closed 1m still moves with our side (BUY+green / SELL+red). */
export function minuteContinuesWithSide(side: ExitSide, c: CandleOHLC): boolean {
  const d = minuteCandleDir(c);
  if (d === 'FLAT') return false;
  return (side === 'BUY' && d === 'UP') || (side === 'SELL' && d === 'DOWN');
}

/** Closed 1m prints against our side (BUY+red / SELL+green). */
export function minuteReversesSide(side: ExitSide, c: CandleOHLC): boolean {
  const d = minuteCandleDir(c);
  if (d === 'FLAT') return false;
  return (side === 'BUY' && d === 'DOWN') || (side === 'SELL' && d === 'UP');
}

/**
 * Legacy closed-1m profit policy (tests / unused by desk manage).
 * Desk now arms PeakProtect live at MFE ≥ PEAK_PROTECT_ARM_MFE.
 */
export function closed1mProfitPolicy(
  side: ExitSide,
  closed: CandleOHLC,
  prevClosed?: CandleOHLC | null
): 'continue' | 'reverse' | 'wait' {
  if (minuteContinuesWithSide(side, closed)) return 'continue';
  if (!minuteReversesSide(side, closed)) return 'wait';
  if (prevClosed) {
    const prevDir = minuteCandleDir(prevClosed);
    if (prevDir === 'FLAT') return 'reverse';
    if (minuteContinuesWithSide(side, prevClosed)) return 'reverse';
    return 'reverse';
  }
  return 'reverse';
}

/** Live adverse excursion (pts) that counts as HardInv for flip arming. */
export const HARDINV_FLIP_MAE = 1.5;

/**
 * Opposite SCALP side after a HardInv-class close (soft or broker SL).
 * No chain: if the closed trade was already HARDINV_FLIP, return null.
 */
export function hardInvFlipSide(
  closedSide: ExitSide | null | undefined,
  entrySetup?: string | null
): ExitSide | null {
  if (!closedSide) return null;
  if (String(entrySetup || '').toUpperCase() === 'HARDINV_FLIP') return null;
  return closedSide === 'BUY' ? 'SELL' : 'BUY';
}

/**
 * After HardInvalidation reason: opposite side for a one-shot SCALP.
 * No chain: if the closed trade was already HARDINV_FLIP, return null.
 */
export function hardInvOppositeScalpSide(
  reason: string,
  closedSide: ExitSide | null | undefined,
  entrySetup?: string | null
): ExitSide | null {
  if (!closedSide || !/HardInvalidation/i.test(reason)) return null;
  return hardInvFlipSide(closedSide, entrySetup);
}

/** Broker/external close that already ate ≥1.5pt MAE — treat as HardInv for flip. */
export function shouldArmHardInvFlipFromMae(
  mae: number,
  closedSide: ExitSide | null | undefined,
  entrySetup?: string | null,
  floor = HARDINV_FLIP_MAE
): ExitSide | null {
  if (!Number.isFinite(mae) || mae > -floor) return null;
  return hardInvFlipSide(closedSide, entrySetup);
}

/**
 * After HardInv close Capital often still lists the old leg briefly.
 * Flip must not re-adopt that ghost and must not wait for a 1m candle.
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
  const fromRegime = playbookFromRegime(s.regime);
  if (fromRegime === 'WAIT') return 'SCALP';
  return fromRegime;
}

/**
 * Manage exit divided by playbook (LONG / SCALP / FADE) — same rules for ALL exits.
 * Broker SAFETY SL remains the hard cushion outside this function.
 *
 * Desk wiring:
 * - live_loss: HardInv 1.5pt ONLY on live mark (never thesis / micro-red scratch)
 * - peak_protect_only: PeakProtect 75% only (armed live at MFE ≥ 1.5pt; trails live)
 * - all: full suite (tests)
 *
 * Profit path on desk: PeakProtect arms live at MFE ≥ 1.5pt — trail 75% giveback.
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
  const retention =
    s.peak_retention != null
      ? s.peak_retention
      : mfe > 0
        ? Math.max(0, fav / mfe)
        : null;

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantPeakOnly = gate === 'peak_protect_only';
  const wantProfit =
    gate === 'all' || gate === 'live_profit' || gate === 'closed_1m_profit';

  if (wantLoss) {
    // HardInv ONLY at 1.5pt (all books). NO thesis / micro-red scratch.
    // User: do not exit -0.19 noise — next 1m can still make the profit.
    if (fav <= -sl) {
      return {
        exit: true,
        reason: `HardInvalidation · ${book} · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
      };
    }
  }

  // Armed at MFE ≥ 1.5 — PeakProtect giveback only (no Target / TimeDecay)
  if (wantPeakOnly) {
    if (mfe >= mfeFloor && fav > 0 && retention != null && retention < p.peakRet) {
      return {
        exit: true,
        reason: `PeakProtection · ${book} · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · live`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantProfit) {
    // 3) PeakProtect — only after real leg (75% retention)
    if (mfe >= mfeFloor && retention != null && retention < p.peakRet) {
      return {
        exit: true,
        reason: `PeakProtection · ${book} · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)}`,
      };
    }

    if (fav >= tp) {
      return {
        exit: true,
        reason: `Target · ${book} · ${s.entry_setup || ''} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
      };
    }

    if (
      mfe >= mfeFloor &&
      fav > 0 &&
      retention != null &&
      retention < p.harvestRet &&
      retention >= p.peakRet
    ) {
      return {
        exit: true,
        reason: `BestOutcome harvest · ${book} · UPL ${fav.toFixed(5)} after MFE ${mfe.toFixed(5)} (ret ${(retention * 100).toFixed(0)}%)`,
      };
    }

    if (heldMs > p.timeDecayMs && fav >= 0 && mfe < mfeFloor) {
      return {
        exit: true,
        reason: `TimeDecay · ${book} · held ${Math.round(heldMs / 1000)}s · UPL ${fav.toFixed(5)}`,
      };
    }
  }

  return { exit: false, reason: '' };
}
