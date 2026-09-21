/** Live Capital exit — HardInv live; PeakProtect after reverse 1m (25% giveback). */
import { getDeskCalibration } from './deskCalibration.js';

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
  /** Wall ms when Soft HardInv first saw breach — null/0 = not breaching */
  hardinv_breach_since_ms?: number | null;
};

export type CandleOHLC = { open: number; close: number };

export type MinuteDir = 'UP' | 'DOWN' | 'FLAT';

/**
 * Desk gates:
 * - live_loss: Soft HardInv only (no thesis micro-scratch)
 * - peak_protect_only: PeakProtect giveback only (armed after reverse 1m)
 * - target_time: Target + TimeDecay only (green winners without waiting Peak)
 * - all: both (tests / fallback)
 */
export type ExitDecideGate = 'all' | 'live_loss' | 'peak_protect_only' | 'target_time';

export type ExitDecision = {
  exit: boolean;
  reason: string;
  /** Soft HardInv currently beyond SL — desk should stamp/clear breach timer */
  hardinv_breaching?: boolean;
};

/** Keep 75% of MFE → give back at most 25% (all scalps). */
export const PEAK_MFE_RETENTION = 0.75;
export const MAX_MFE_GIVEBACK = 0.25;

/** Gold-scale absolute floors — % alone allowed 0.08–0.15pt micro-scratches. */
export const HARDINV_ABS_FLOOR = 1.5;
export const PEAK_MFE_ABS_FLOOR = 1.5;
/** Need real giveback in price pts before Peak cuts (chop-safe). */
export const PEAK_MIN_GIVEBACK_ABS = 0.75;
export const TARGET_ABS_FLOOR = 4.0;

/**
 * First seconds after fill — spread settle + first pushback wick.
 * Broker SAFETY SL still protects; Soft HardInv waits.
 */
export const HARDINV_GRACE_MS = 25_000;
/**
 * Soft HardInv must stay breached this long (anti “magic minus” on 1m wick
 * that immediately reverses — classic RANGE half-buy then green).
 */
export const HARDINV_CONFIRM_MS = 12_000;
/** RANGE/COMPRESSION noise multiplier on Soft HardInv distance */
export const HARDINV_RANGE_MULT = 1.6;
/** TimeDecay min hold — was 8m and collided with chop exits */
export const TIMEDECAY_MIN_HOLD_MS = 12 * 60_000;
/**
 * TimeDecay must lock REAL mid edge past spread, or covering a short/buying
 * a long at ask/bid prints a tiny broker minus (“magic minus” at fav≈0).
 */
export const TIMEDECAY_MIN_FAV_ABS = 0.75;

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

/** Opposite regime vs open side — diagnostic only (does NOT auto-exit). */
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

function peakShouldCut(
  fav: number,
  mfe: number,
  retention: number | null,
  mfeFloor: number,
  peakRet: number,
  minGiveback: number
): boolean {
  // Peak locks profit only — never micro-red after reverse 1m
  if (!(fav > 0)) return false;
  if (mfe < mfeFloor) return false;
  if (retention == null || retention >= peakRet) return false;
  const giveback = mfe - fav;
  if (giveback < minGiveback) return false;
  return true;
}

/** Soft HardInv distance in price pts — wider in RANGE/COMPRESSION chop. */
export function hardInvStopDistance(
  entry: number,
  regime?: string | null
): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  let sl = Math.max(absEntry * cal.hardinv_pct, cal.hardinv_abs || HARDINV_ABS_FLOOR);
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (r === 'RANGE' || r === 'COMPRESSION') {
    sl *= HARDINV_RANGE_MULT;
  }
  return sl;
}

/**
 * Manage exit — winners hold on 1m continue; Peak 25% giveback after reverse.
 * Soft HardInv caps losers with grace + confirm (no single-wick “magic minus”).
 * Peak never cuts red — only green with ≥0.75pt giveback after real MFE.
 * Broker SAFETY SL remains the hard cushion outside this function.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  gate: ExitDecideGate = 'all',
  nowMs = Date.now()
): ExitDecision {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  const peakRet = cal.peak_retention > 0 ? cal.peak_retention : PEAK_MFE_RETENTION;
  const minGiveback =
    cal.peak_min_giveback_abs > 0 ? cal.peak_min_giveback_abs : PEAK_MIN_GIVEBACK_ABS;
  // Asymmetric + Gold floors from desk calibration (Control panel knobs)
  const tp = Math.max(absEntry * cal.target_pct, cal.target_abs || TARGET_ABS_FLOOR);
  const sl = hardInvStopDistance(entry, s.regime);
  const mfeFloor = Math.max(
    absEntry * cal.peak_mfe_pct,
    cal.peak_mfe_abs || PEAK_MFE_ABS_FLOOR
  );
  const mfe = Math.max(s.mfe, Math.max(0, fav));
  const retention =
    s.peak_retention != null
      ? s.peak_retention
      : mfe > 0
        ? Math.max(0, fav / mfe)
        : null;
  const heldMs = s.entry_at ? nowMs - new Date(s.entry_at).getTime() : 0;

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantPeakOnly = gate === 'peak_protect_only';
  const wantFullProfit = gate === 'all' || gate === 'target_time';

  if (wantLoss) {
    let breaching = false;
    if (heldMs >= HARDINV_GRACE_MS && fav <= -sl) {
      breaching = true;
      const since = s.hardinv_breach_since_ms;
      if (since != null && Number.isFinite(since) && since > 0) {
        const breachedFor = nowMs - since;
        if (breachedFor >= HARDINV_CONFIRM_MS) {
          return {
            exit: true,
            reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)} · held ${Math.round(heldMs / 1000)}s · confirm ${Math.round(breachedFor / 1000)}s`,
            hardinv_breaching: true,
          };
        }
      }
    }
    // Thesis is diagnostic only — micro-red regime flicker must NOT scratch
    if (gate === 'live_loss') {
      return { exit: false, reason: '', hardinv_breaching: breaching };
    }
  }

  // Armed after reverse 1m — PeakProtect giveback only (25%), green only
  if (wantPeakOnly) {
    if (peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)) {
      const givePct = ((1 - peakRet) * 100).toFixed(0);
      return {
        exit: true,
        reason: `PeakProtection · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · giveback≤${givePct}%`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantFullProfit) {
    if (gate === 'all' && peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)) {
      return {
        exit: true,
        reason: `PeakProtection · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} → lock best`,
      };
    }

    if (fav >= tp) {
      return {
        exit: true,
        reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
      };
    }

    // Never TimeDecay at fav≈0 — mid flat + spread on close = tiny broker loss (user −£0.06)
    const minFav = Math.max(
      TIMEDECAY_MIN_FAV_ABS,
      absEntry * 0.0002,
      (cal.target_abs || TARGET_ABS_FLOOR) * 0.3
    );
    if (heldMs > TIMEDECAY_MIN_HOLD_MS && fav >= minFav && mfe >= mfeFloor) {
      return {
        exit: true,
        reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · lock UPL ${fav.toFixed(5)} ≥ min ${minFav.toFixed(5)}`,
      };
    }
  }

  return { exit: false, reason: '' };
}
