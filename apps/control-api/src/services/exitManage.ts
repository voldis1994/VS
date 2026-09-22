/** Live Capital exit — cut losers fast; let winners run / lock real +R. */
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

/** Keep ~65% of MFE → give back at most ~35% once a real leg exists. */
export const PEAK_MFE_RETENTION = 0.65;
export const MAX_MFE_GIVEBACK = 0.35;

/**
 * Gold-scale floors / caps.
 * Soft HardInv CAP (~2.2) must stay WELL BELOW Target / Peak MFE floors —
 * otherwise 80% tiny Peak wins + few large HardInv losses = negative expectancy.
 */
export const HARDINV_ABS_FLOOR = 1.5;
/** Cap Soft HardInv — `hardinv_abs` calibration knob is a CAP, not a floor. */
export const HARDINV_ABS_CAP = 2.2;
export const PEAK_MFE_ABS_FLOOR = 3.0;
/** Need real giveback in price pts before Peak cuts (chop-safe). */
export const PEAK_MIN_GIVEBACK_ABS = 0.85;
export const TARGET_ABS_FLOOR = 4.0;

/**
 * First seconds after fill — spread settle + first pushback wick.
 * Broker SAFETY SL still protects; Soft HardInv waits.
 * Kept short so losers are not allowed to run for half a minute.
 */
export const HARDINV_GRACE_MS = 12_000;
/**
 * Soft HardInv must stay breached this long (anti single-wick “magic minus”).
 * Short confirm — still debounce, but do not gift 37s of free adverse travel.
 */
export const HARDINV_CONFIRM_MS = 5_000;
/**
 * RANGE/COMPRESSION noise — slight widen only.
 * Was 1.6 and pushed Soft HardInv past SAFETY (~6pt Gold) while Peak banked +0.5.
 */
export const HARDINV_RANGE_MULT = 1.15;
/** TimeDecay min hold */
export const TIMEDECAY_MIN_HOLD_MS = 12 * 60_000;
/**
 * TimeDecay must lock REAL mid edge — at least ~half Soft HardInv,
 * never +0.75 winners against −4 Soft losses.
 */
export const TIMEDECAY_MIN_FAV_ABS = 2.0;

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
 * - continue: same direction → HOLD (PeakProtect stays armed if already on)
 * - reverse: flipped against side → PeakProtect ARMS (live trail)
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
  _retentionIgnored: number | null,
  mfeFloor: number,
  peakRet: number,
  minGiveback: number
): boolean {
  // Peak locks profit only — never micro-red after reverse 1m
  if (!(fav > 0)) return false;
  if (mfe < mfeFloor) return false;
  // Always use LIVE fav/mfe — stale s.peak_retention (from prior mid) must not skip a cut
  const liveRet = fav / mfe;
  if (liveRet >= peakRet) return false;
  const giveback = mfe - fav;
  if (giveback < minGiveback) return false;
  return true;
}

/** Peak MFE floor for this entry (desk calibration + absolute floor). */
export function peakMfeFloor(entry: number): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  return Math.max(
    absEntry * cal.peak_mfe_pct,
    cal.peak_mfe_abs || PEAK_MFE_ABS_FLOOR,
    PEAK_MFE_ABS_FLOOR
  );
}

/**
 * Soft HardInv distance in price pts.
 * `hardinv_abs` is a CAP (positive R:R) — Gold % must not push Soft SL to 4–6pt
 * while Peak banks +0.5–2pt.
 */
export function hardInvStopDistance(
  entry: number,
  regime?: string | null
): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  const pct = absEntry * cal.hardinv_pct;
  const floor = HARDINV_ABS_FLOOR;
  const cap =
    cal.hardinv_abs > 0 ? cal.hardinv_abs : HARDINV_ABS_CAP;
  let sl = Math.min(Math.max(pct, floor), cap);
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (r === 'RANGE' || r === 'COMPRESSION') {
    sl *= HARDINV_RANGE_MULT;
    // Still never explode past ~1.25× cap after RANGE widen
    sl = Math.min(sl, cap * 1.25);
  }
  return sl;
}

/**
 * After a real favorable excursion (≥ Soft HardInv), Soft line moves to a
 * small BE lock so greens cannot fully reverse into a max Soft loss.
 */
export function softLossLine(sl: number, mfe: number): number {
  if (mfe >= sl) {
    // BE / tiny lock — cut when fav drops back to ≤ +0.25 (or −0 if flat)
    return Math.min(0.25, sl * 0.12);
  }
  return -sl;
}

/**
 * Peak-eligible trade approaching BE while still green — lock remaining +R
 * BEFORE Soft HardInv confirm lets price flip red (multi-account same-market race).
 */
export function peakBeGuardShouldCut(
  fav: number,
  mfe: number,
  mfeFloor: number,
  sl: number
): boolean {
  if (!(fav > 0)) return false;
  if (mfe < mfeFloor) return false;
  return fav <= softLossLine(sl, mfe);
}

/**
 * Manage exit — winners hold on 1m continue; Peak giveback after reverse / MFE arm.
 * Soft HardInv caps losers with short grace + confirm.
 * Peak never cuts red — only green after real MFE (≥3pt floor).
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
  // Target: enforce absolute floor so % never undercuts positive R:R vs Soft HardInv
  const tp = Math.max(
    absEntry * cal.target_pct,
    cal.target_abs || 0,
    TARGET_ABS_FLOOR
  );
  const sl = hardInvStopDistance(entry, s.regime);
  const mfeFloor = peakMfeFloor(entry);
  const mfe = Math.max(s.mfe, Math.max(0, fav));
  const liveRet = mfe > 0 ? Math.max(0, fav / mfe) : null;
  const retention = liveRet;
  const heldMs = s.entry_at ? nowMs - new Date(s.entry_at).getTime() : 0;
  const peakEligible = mfe >= mfeFloor;

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantPeakOnly = gate === 'peak_protect_only';
  const wantFullProfit = gate === 'all' || gate === 'target_time';

  if (wantLoss) {
    let breaching = false;
    const lossLine = softLossLine(sl, mfe);
    // Peak-eligible + still green near BE → Soft must NOT own the exit (Peak/BE-guard does).
    // This stops Soft confirm from holding while price flips red after a real Peak MFE.
    if (peakEligible && fav > 0 && fav <= lossLine) {
      if (gate === 'live_loss') {
        return { exit: false, reason: '', hardinv_breaching: false };
      }
    }
    if (heldMs >= HARDINV_GRACE_MS && fav <= lossLine) {
      // Peak-eligible underwater: cut without inventing a green — Soft is last resort
      breaching = true;
      const since = s.hardinv_breach_since_ms;
      if (since != null && Number.isFinite(since) && since > 0) {
        const breachedFor = nowMs - since;
        // Shorter confirm once Peak already had a real leg — don't gift more red travel
        const needConfirm = peakEligible ? Math.min(HARDINV_CONFIRM_MS, 2_000) : HARDINV_CONFIRM_MS;
        if (breachedFor >= needConfirm) {
          const beTag = mfe >= sl ? ' · BE-lock' : '';
          return {
            exit: true,
            reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ ${lossLine.toFixed(5)} (SL ${sl.toFixed(5)})${beTag} · held ${Math.round(heldMs / 1000)}s · confirm ${Math.round(breachedFor / 1000)}s`,
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

  // PeakProtect giveback / BE-guard — green only, real MFE
  if (wantPeakOnly) {
    if (peakBeGuardShouldCut(fav, mfe, mfeFloor, sl)) {
      return {
        exit: true,
        reason: `PeakProtection · BE-guard · lock UPL ${fav.toFixed(5)} after MFE ${mfe.toFixed(5)} (no red giveback)`,
      };
    }
    if (peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)) {
      const givePct = ((1 - peakRet) * 100).toFixed(0);
      return {
        exit: true,
        reason: `PeakProtection · retention ${((retention ?? 0) * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · giveback≤${givePct}%`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantFullProfit) {
    if (gate === 'all' && peakBeGuardShouldCut(fav, mfe, mfeFloor, sl)) {
      return {
        exit: true,
        reason: `PeakProtection · BE-guard · lock UPL ${fav.toFixed(5)} after MFE ${mfe.toFixed(5)}`,
      };
    }
    if (gate === 'all' && peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)) {
      return {
        exit: true,
        reason: `PeakProtection · retention ${((retention ?? 0) * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} → lock best`,
      };
    }

    if (fav >= tp) {
      return {
        exit: true,
        reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
      };
    }

    // Never TimeDecay at fav≈0 — mid flat + spread on close = tiny broker loss
    const minFav = Math.max(
      TIMEDECAY_MIN_FAV_ABS,
      absEntry * 0.00035,
      sl * 0.9,
      (cal.target_abs || TARGET_ABS_FLOOR) * 0.4
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
