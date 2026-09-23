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
 * BE lock so greens cannot fully reverse into a max Soft loss.
 *
 * MUST clear typical Capital Gold half-spread on market close.
 * Old +0.25 → mid “green” +0.08 then DELETE at bid/ask = Funds magic-minus
 * (−€0.05…−€0.15 every scratch). Same class as TimeDecay-at-flat bug.
 */
export const BE_LOCK_MIN_ABS = 1.0;
/** Executable (bid/ask) edge required to fire BE-lock — else HOLD through dead zone. */
export const BE_LOCK_MIN_EXEC = 0.5;

export function softLossLine(sl: number, mfe: number): number {
  if (mfe >= sl) {
    return Math.max(BE_LOCK_MIN_ABS, Math.min(sl * 0.5, 1.5));
  }
  return -sl;
}

/**
 * Favorable move at **executable** close price (BUY→bid, SELL→ask).
 * Falls back to mid when quote legs missing.
 */
export function executableFavorable(
  side: ExitSide,
  entry: number,
  bid: number | null | undefined,
  ask: number | null | undefined,
  mid: number
): number {
  if (side === 'BUY') {
    const px = bid != null && Number.isFinite(bid) ? bid : mid;
    return px - entry;
  }
  const px = ask != null && Number.isFinite(ask) ? ask : mid;
  return entry - px;
}

/** Gold Soft/Peak abs floors are meaningless on Heating Oil (~2) — block live entry. */
export const GOLD_DESK_MIN_MID = 500;

export function epicSupportsGoldDeskCalibration(mid: number | null | undefined): boolean {
  return mid != null && Number.isFinite(mid) && mid >= GOLD_DESK_MIN_MID;
}

export type ExitQuoteLegs = {
  bid?: number | null;
  ask?: number | null;
};

/**
 * Manage exit — winners hold on 1m continue; Peak giveback after reverse.
 * Soft HardInv caps losers with short grace + confirm.
 * Peak never cuts red — only green after real MFE (≥3pt floor).
 * Broker SAFETY SL remains the hard cushion outside this function.
 *
 * Pass bid/ask when available — BE-lock / Peak / Target must not fire on mid
 * “green” that is cash-red after market close through the spread.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  gate: ExitDecideGate = 'all',
  nowMs = Date.now(),
  quote?: ExitQuoteLegs | null
): ExitDecision {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const execFav = executableFavorable(
    s.open_side,
    entry,
    quote?.bid,
    quote?.ask,
    mid
  );
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
  const mfeFloor = Math.max(
    absEntry * cal.peak_mfe_pct,
    cal.peak_mfe_abs || PEAK_MFE_ABS_FLOOR,
    PEAK_MFE_ABS_FLOOR
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
    const lossLine = softLossLine(sl, mfe);
    const beMode = mfe >= sl;
    if (heldMs >= HARDINV_GRACE_MS && fav <= lossLine) {
      // BE-lock dead zone: mid near flat but close would be cash-red → HOLD
      // (Full Soft −sl still cuts when fav ≤ −sl.)
      if (beMode && execFav < BE_LOCK_MIN_EXEC && fav > -sl) {
        if (gate === 'live_loss') {
          return { exit: false, reason: '', hardinv_breaching: false };
        }
      } else {
        breaching = true;
        const since = s.hardinv_breach_since_ms;
        if (since != null && Number.isFinite(since) && since > 0) {
          const breachedFor = nowMs - since;
          if (breachedFor >= HARDINV_CONFIRM_MS) {
            const beTag = beMode ? ' · BE-lock' : '';
            return {
              exit: true,
              reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ ${lossLine.toFixed(5)} (SL ${sl.toFixed(5)})${beTag} · exec ${execFav.toFixed(5)} · held ${Math.round(heldMs / 1000)}s · confirm ${Math.round(breachedFor / 1000)}s`,
              hardinv_breaching: true,
            };
          }
        }
      }
    }
    // Thesis is diagnostic only — micro-red regime flicker must NOT scratch
    if (gate === 'live_loss') {
      return { exit: false, reason: '', hardinv_breaching: breaching };
    }
  }

  // Armed after reverse 1m — PeakProtect giveback only, green only, real MFE
  if (wantPeakOnly) {
    if (
      execFav >= BE_LOCK_MIN_EXEC &&
      peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)
    ) {
      const givePct = ((1 - peakRet) * 100).toFixed(0);
      return {
        exit: true,
        reason: `PeakProtection · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · giveback≤${givePct}% · exec ${execFav.toFixed(5)}`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantFullProfit) {
    if (
      gate === 'all' &&
      execFav >= BE_LOCK_MIN_EXEC &&
      peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)
    ) {
      return {
        exit: true,
        reason: `PeakProtection · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} → lock best · exec ${execFav.toFixed(5)}`,
      };
    }

    if (fav >= tp && execFav >= BE_LOCK_MIN_EXEC) {
      return {
        exit: true,
        reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)} · exec ${execFav.toFixed(5)}`,
      };
    }

    // Never TimeDecay at fav≈0 — mid flat + spread on close = tiny broker loss
    const minFav = Math.max(
      TIMEDECAY_MIN_FAV_ABS,
      absEntry * 0.00035,
      sl * 0.9,
      (cal.target_abs || TARGET_ABS_FLOOR) * 0.4
    );
    if (
      heldMs > TIMEDECAY_MIN_HOLD_MS &&
      fav >= minFav &&
      execFav >= BE_LOCK_MIN_EXEC &&
      mfe >= mfeFloor
    ) {
      return {
        exit: true,
        reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · lock UPL ${fav.toFixed(5)} ≥ min ${minFav.toFixed(5)} · exec ${execFav.toFixed(5)}`,
      };
    }
  }

  return { exit: false, reason: '' };
}
