/** Live Capital exit — HardInv live; PeakProtect after reverse 1m (25% giveback). */

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
};

export type CandleOHLC = { open: number; close: number };

export type MinuteDir = 'UP' | 'DOWN' | 'FLAT';

/**
 * Desk gates:
 * - live_loss: HardInv / red thesis — fire on live mark
 * - peak_protect_only: PeakProtect giveback only (armed after reverse 1m)
 * - all: both (tests / fallback)
 */
export type ExitDecideGate = 'all' | 'live_loss' | 'peak_protect_only';

/** Keep 75% of MFE → give back at most 25% (all scalps). */
export const PEAK_MFE_RETENTION = 0.75;
export const MAX_MFE_GIVEBACK = 0.25;

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

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
 * Profit-side policy on a newly closed Capital 1m:
 * - continue: same direction → HOLD (PeakProtect stays OFF)
 * - reverse: flipped against side → PeakProtect % ARMS (live trail)
 * - wait: doji / no clear signal
 */
export function closed1mProfitPolicy(
  side: ExitSide,
  closed: CandleOHLC,
  _prevClosed?: CandleOHLC | null
): 'continue' | 'reverse' | 'wait' {
  if (minuteContinuesWithSide(side, closed)) return 'continue';
  if (minuteReversesSide(side, closed)) return 'reverse';
  return 'wait';
}

/** Opposite regime vs open side — original PositionManager thesis failure. */
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

/**
 * Manage exit — winners hold on 1m continue; Peak 25% giveback after reverse.
 * Soft HardInv caps losers; TP ≫ SL so avg win can beat avg loss.
 * Broker SAFETY SL remains the hard cushion outside this function.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  gate: ExitDecideGate = 'all'
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  // Asymmetric: TP room > Soft HardInv so winners can outsize losers
  const tp = Math.max(absEntry * 0.0035, 0.35);
  const sl = Math.max(absEntry * 0.0015, 0.15);
  const mfeFloor = Math.max(absEntry * 0.0008, 0.08);
  const mfe = Math.max(s.mfe, Math.max(0, fav));
  const retention =
    s.peak_retention != null
      ? s.peak_retention
      : mfe > 0
        ? Math.max(0, fav / mfe)
        : null;
  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantPeakOnly = gate === 'peak_protect_only';
  const wantFullProfit = gate === 'all';

  if (wantLoss) {
    if (fav <= -sl) {
      return {
        exit: true,
        reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`,
      };
    }
    // Never scratch a green trade on regime flicker — only when underwater
    const thesis = thesisFailureReason(s.open_side, s.regime);
    if (thesis && fav <= 0 && heldMs >= 60_000) {
      return { exit: true, reason: thesis };
    }
  }

  // Armed after reverse 1m — PeakProtect giveback only (25%)
  if (wantPeakOnly) {
    if (mfe >= mfeFloor && retention != null && retention < PEAK_MFE_RETENTION) {
      return {
        exit: true,
        reason: `PeakProtection · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · giveback≤${(
          MAX_MFE_GIVEBACK * 100
        ).toFixed(0)}%`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantFullProfit) {
    if (mfe >= mfeFloor && retention != null && retention < PEAK_MFE_RETENTION) {
      return {
        exit: true,
        reason: `PeakProtection · retention ${(retention * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} → lock best`,
      };
    }

    if (fav >= tp) {
      return {
        exit: true,
        reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
      };
    }

    if (heldMs > 480_000 && fav >= 0 && mfe >= mfeFloor * 0.5) {
      return {
        exit: true,
        reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize non-negative best UPL ${fav.toFixed(5)}`,
      };
    }
  }

  return { exit: false, reason: '' };
}
