/** Live Capital exit — cut losers fast; let winners run / lock real +R. */
import { getDeskCalibration } from './deskCalibration.js';
import {
  regimeExitProfile,
  structureInvalidationReason,
  type ExitZoneSnap,
} from './regimeExitProfile.js';

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  /** Live regime (UI / secondary) — Soft/Peak prefer entry_regime when set */
  regime?: string | null;
  /** Regime frozen at fill — exit thesis */
  entry_regime?: string | null;
  /** Setup frozen at fill (PULLBACK / BREAKOUT / FADE / …) */
  entry_setup?: string | null;
  /** Zone geometry frozen at fill — structure invalidation */
  entry_zone?: ExitZoneSnap | null;
  /** Wall ms when Soft HardInv first saw breach — null/0 = not breaching */
  hardinv_breach_since_ms?: number | null;
  /** Wall ms when structure invalidation first seen */
  structure_breach_since_ms?: number | null;
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
  /** Structure invalidation currently true — desk stamps structure_breach_since_ms */
  structure_breaching?: boolean;
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
/** Broker SAFETY TP must be ≥ this × SAFETY SL distance — never TP < SL */
export const SAFETY_TP_MIN_RR = 1.5;

/**
 * Soft Target distance in price pts (manage Target gate).
 * Broker SAFETY TP uses {@link safetyTakeProfitDistance} which enforces R:R vs SL.
 */
export function targetTakeProfitDistance(
  entry: number,
  regime?: string | null
): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  const profile = regimeExitProfile(regime);
  return (
    Math.max(
      absEntry * cal.target_pct,
      scaleDeskAbs(cal.target_abs || TARGET_ABS_FLOOR, absEntry),
      scaleDeskAbs(TARGET_ABS_FLOOR, absEntry)
    ) * profile.target_mult
  );
}

/**
 * Broker SAFETY TP distance — opposite of SAFETY SL / Soft HardInv.
 * Always ≥ max(Target, SAFETY_SL×1.5, SoftHardInv×1.5) so R:R is never inverted.
 */
export function safetyTakeProfitDistance(
  entry: number,
  regime?: string | null,
  opts?: {
    minStopDistance?: number | null;
    /** Actual SAFETY SL cushion in price pts (preferred) */
    stopDistancePrice?: number | null;
  }
): number {
  let dist = targetTakeProfitDistance(entry, regime);
  const min =
    opts?.minStopDistance != null &&
    Number.isFinite(opts.minStopDistance) &&
    opts.minStopDistance > 0
      ? opts.minStopDistance
      : 0;
  if (min > 0) dist = Math.max(dist, min * 1.05);

  const softSl = hardInvStopDistance(entry, regime);
  const cushion = Math.max(Math.abs(entry), 1e-9) * 0.002; // same % as SAFETY SL pillow
  const slRef =
    opts?.stopDistancePrice != null &&
    Number.isFinite(opts.stopDistancePrice) &&
    opts.stopDistancePrice > 0
      ? opts.stopDistancePrice
      : Math.max(softSl, cushion);
  const cal = getDeskCalibration();
  const rr = Math.max(SAFETY_TP_MIN_RR, Number(cal.safety_tp_rr) || SAFETY_TP_MIN_RR);
  dist = Math.max(dist, slRef * rr, softSl * rr);
  return dist;
}

/** Absolute Capital profitLevel — BUY above entry / SELL below entry. */
export function safetyTakeProfitLevel(
  side: ExitSide,
  entry: number,
  regime?: string | null,
  minStopDistance?: number | null,
  stopDistancePrice?: number | null
): number {
  const dist = safetyTakeProfitDistance(entry, regime, {
    minStopDistance,
    stopDistancePrice,
  });
  const abs = Math.max(Math.abs(entry), 1e-9);
  const raw = side === 'BUY' ? entry + dist : entry - dist;
  if (abs >= 1000) return Math.round(raw * 10) / 10;
  if (abs >= 100) return Math.round(raw * 100) / 100;
  if (abs >= 1) return Math.round(raw * 10000) / 10000;
  return Math.round(raw * 1e6) / 1e6;
}

/**
 * Capital profitDistance in POINTS — always ≥ SAFETY_TP_MIN_RR × stopDistance pts.
 */
export function safetyTakeProfitDistancePts(
  entry: number,
  regime: string | null | undefined,
  minPts: number | null | undefined,
  pointSize: number | null | undefined,
  stopDistancePts?: number | null
): number {
  const ps = pointSize != null && pointSize > 0 ? pointSize : null;
  const stopPrice =
    stopDistancePts != null && stopDistancePts > 0 && ps != null
      ? stopDistancePts * ps
      : null;
  const distPrice = safetyTakeProfitDistance(entry, regime, {
    minStopDistance:
      minPts != null && minPts > 0 && ps != null ? minPts * ps : null,
    stopDistancePrice: stopPrice,
  });
  const min = minPts != null && minPts > 0 ? minPts : 0;
  let pts = ps != null ? distPrice / ps : distPrice;
  if (stopDistancePts != null && stopDistancePts > 0) {
    const rr = Math.max(
      SAFETY_TP_MIN_RR,
      Number(getDeskCalibration().safety_tp_rr) || SAFETY_TP_MIN_RR
    );
    pts = Math.max(pts, stopDistancePts * rr);
  }
  pts = Math.max(pts, min * 1.05, min + 1e-9);
  return pts >= 10 ? Math.ceil(pts) : Math.round(pts * 100) / 100;
}

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
/** TimeDecay default hold (overridden per regime profile) */
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
 * Soft / Peak / Target abs knobs are tuned once at REF mid (~DESK_REF_MID).
 * Candles/regimes look the same on **every** market — only size changes.
 * Scale abs pts by entry/REF so all epics share the same % R:R.
 * One desk calibration — not per-market.
 */
export const DESK_REF_MID = 2000;

/** Map a REF-tuned absolute (pts at REF) onto this instrument's price. */
export function scaleDeskAbs(refAbsPts: number, entry: number): number {
  const mid = Math.max(Math.abs(entry), 1e-9);
  return Math.max(refAbsPts * (mid / DESK_REF_MID), mid * 1e-9);
}

/**
 * Soft HardInv distance in price pts.
 * Base CAP/floor at REF, then × regime exit profile (entry thesis).
 */
export function hardInvStopDistance(
  entry: number,
  regime?: string | null
): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  const pct = absEntry * cal.hardinv_pct;
  const floor = scaleDeskAbs(HARDINV_ABS_FLOOR, absEntry);
  const capGold = cal.hardinv_abs > 0 ? cal.hardinv_abs : HARDINV_ABS_CAP;
  const cap = scaleDeskAbs(capGold, absEntry);
  let sl = Math.min(Math.max(pct, floor), cap);
  const profile = regimeExitProfile(regime);
  sl *= profile.hardinv_mult;
  // Never explode past ~1.3× scaled cap after regime widen (RANGE 1.15 etc.)
  sl = Math.min(sl, cap * 1.3);
  return sl;
}

/** Structure invalidation grace / confirm (faster than Soft Soft — thesis broken). */
export const STRUCTURE_GRACE_MS = 8_000;
export const STRUCTURE_CONFIRM_MS = 3_000;

/**
 * After a real favorable excursion (≥ Soft HardInv), Soft line moves to
 * true flat so greens cannot reverse into a full Soft loss.
 *
 * Lock is NOT a profit harvest — old 0.45 / even 0.05 Soft still banked
 * Funds +£0.01…+£0.03 while Soft losers took −£0.06. Real winners =
 * Peak/Target with exec ≥ Soft (1:1 min vs Soft loss).
 */
export const BE_LOCK_FRAC = 0;
/** Executable edge as fraction of Soft SL — only while mid still green (magic-minus). */
export const BE_LOCK_EXEC_FRAC = 0.25;

export function softLossLine(sl: number, mfe: number): number {
  if (mfe >= sl) {
    // True BE — never harvest a slice of Soft as a "win"
    return 0;
  }
  return -sl;
}

export function beLockMinExec(sl: number): number {
  return Math.max(sl * BE_LOCK_EXEC_FRAC, sl * 1e-9);
}

/**
 * Soft profit exits (Peak / Target / TimeDecay) must bank at least Soft HardInv
 * — otherwise Funds shows +£0.01…+£0.03 vs −£0.06 Soft (inverted R:R).
 */
export function minProfitBank(sl: number): number {
  return Math.max(sl, sl * 1e-9);
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

export type ExitQuoteLegs = {
  bid?: number | null;
  ask?: number | null;
};

/**
 * Manage exit — Soft HardInv + per-regime Peak/Target/TimeDecay + structure kill.
 * Peak never cuts red — only green after real MFE (profile-scaled floor).
 * Broker SAFETY SL remains the hard cushion outside this function.
 *
 * Pass bid/ask when available — BE-lock / Peak / Target must not fire on mid
 * “green” that is cash-red after market close through the spread.
 *
 * Uses entry_regime (frozen at fill) when set; falls back to live regime.
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
  const thesisRegime = s.entry_regime || s.regime;
  const profile = regimeExitProfile(thesisRegime);
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
  const peakRet =
    profile.peak_retention != null && profile.peak_retention > 0
      ? profile.peak_retention
      : cal.peak_retention > 0
        ? cal.peak_retention
        : PEAK_MFE_RETENTION;
  const minGiveback =
    scaleDeskAbs(
      cal.peak_min_giveback_abs > 0 ? cal.peak_min_giveback_abs : PEAK_MIN_GIVEBACK_ABS,
      absEntry
    ) * profile.peak_giveback_mult;
  const tp = targetTakeProfitDistance(entry, thesisRegime);
  const sl = hardInvStopDistance(entry, thesisRegime);
  const minExec = beLockMinExec(sl);
  /** Peak/Target/TimeDecay — never bank below Soft loss size */
  const minBank = minProfitBank(sl);
  const mfeFloor =
    Math.max(
      absEntry * cal.peak_mfe_pct,
      scaleDeskAbs(cal.peak_mfe_abs || PEAK_MFE_ABS_FLOOR, absEntry),
      scaleDeskAbs(PEAK_MFE_ABS_FLOOR, absEntry)
    ) * profile.peak_mfe_mult;
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
    let structureBreaching = false;

    // 1) Structure invalidation — regime thesis dead at the zone (faster confirm)
    const structReason = structureInvalidationReason(
      s.open_side,
      mid,
      thesisRegime,
      s.entry_zone
    );
    if (structReason && heldMs >= STRUCTURE_GRACE_MS) {
      structureBreaching = true;
      const since = s.structure_breach_since_ms;
      if (since != null && Number.isFinite(since) && since > 0) {
        if (nowMs - since >= STRUCTURE_CONFIRM_MS) {
          return {
            exit: true,
            reason: `${structReason} · held ${Math.round(heldMs / 1000)}s · family=${profile.family}`,
            hardinv_breaching: false,
          };
        }
      }
    }

    // 2) Soft HardInv / BE-lock
    const lossLine = softLossLine(sl, mfe);
    const beMode = mfe >= sl;
    if (heldMs >= HARDINV_GRACE_MS && fav <= lossLine) {
      // Magic-minus guard ONLY while mid still green: bid/ask cash-red through
      // spread must not Soft-cut. Once mid ≤ lock (~flat), cut — do not gift
      // a free ride back to full Soft loss (Funds −£0.10 after tiny BE wins).
      if (beMode && fav > 0 && execFav < minExec) {
        if (gate === 'live_loss') {
          return {
            exit: false,
            reason: '',
            hardinv_breaching: false,
            // structure stamp still needed by desk
          };
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
              reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ ${lossLine.toFixed(5)} (SL ${sl.toFixed(5)})${beTag} · exec ${execFav.toFixed(5)} · ${profile.family} · held ${Math.round(heldMs / 1000)}s · confirm ${Math.round(breachedFor / 1000)}s`,
              hardinv_breaching: true,
            };
          }
        }
      }
    }

    if (gate === 'live_loss') {
      return {
        exit: false,
        reason: '',
        hardinv_breaching: breaching,
        structure_breaching: structureBreaching,
      };
    }

    void structureBreaching;
  }

  // Armed after reverse 1m — PeakProtect giveback only, green only, real MFE
  if (wantPeakOnly) {
    if (
      execFav >= minBank &&
      peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)
    ) {
      const givePct = ((1 - peakRet) * 100).toFixed(0);
      return {
        exit: true,
        reason: `PeakProtection · ${profile.family} · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · giveback≤${givePct}% · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantFullProfit) {
    if (
      gate === 'all' &&
      execFav >= minBank &&
      peakShouldCut(fav, mfe, retention, mfeFloor, peakRet, minGiveback)
    ) {
      return {
        exit: true,
        reason: `PeakProtection · ${profile.family} · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} → lock best · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }

    if (fav >= tp && execFav >= minBank) {
      return {
        exit: true,
        reason: `Target / best outcome · ${profile.family} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)} · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }

    const minFav =
      Math.max(
        scaleDeskAbs(TIMEDECAY_MIN_FAV_ABS, absEntry),
        absEntry * 0.00035,
        minBank,
        scaleDeskAbs(cal.target_abs || TARGET_ABS_FLOOR, absEntry) * 0.4
      ) * profile.timedecay_min_fav_mult;
    const holdNeed = profile.timedecay_hold_ms;
    if (
      heldMs > holdNeed &&
      fav >= minFav &&
      execFav >= minBank &&
      mfe >= mfeFloor
    ) {
      return {
        exit: true,
        reason: `TimeDecay · ${profile.family} · held ${Math.round(heldMs / 1000)}s · lock UPL ${fav.toFixed(5)} ≥ min ${minFav.toFixed(5)} · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }
  }

  return { exit: false, reason: '' };
}

/** True when structure invalidation is currently breaching (desk stamps timer). */
export function isStructureBreaching(
  s: ExitSnapshot,
  mid: number,
  nowMs = Date.now()
): boolean {
  if (!s.open_side || s.entry_price == null) return false;
  const heldMs = s.entry_at ? nowMs - new Date(s.entry_at).getTime() : 0;
  if (heldMs < STRUCTURE_GRACE_MS) return false;
  return Boolean(
    structureInvalidationReason(
      s.open_side,
      mid,
      s.entry_regime || s.regime,
      s.entry_zone
    )
  );
}

// Re-export profile helpers for desk / tests
export {
  regimeExitFamily,
  regimeExitProfile,
  shouldArmPeakProtect,
  structureInvalidationReason,
  type ExitZoneSnap,
  type RegimeExitFamily,
  type RegimeExitProfile,
} from './regimeExitProfile.js';
