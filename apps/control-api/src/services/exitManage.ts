/** Live Capital exit — cut losers fast; let winners run / lock real +R. */
import { getDeskCalibration } from './deskCalibration.js';
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';
import {
  genomeTimedecayMinHoldMs,
  regimeExitProfile,
  structureInvalidationReason,
  type ExitZoneSnap,
} from './regimeExitProfile.js';
import {
  activeSoftAbs,
  readSoftTargetLayers,
  targetLayerHit,
} from './profitLayers.js';

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

/** Adaptive brain may tighten Peak trail without rewriting desk knobs. */
export type ExitDecideOverrides = {
  peak_retention_cfg?: number | null;
  peak_mfe_floor?: number | null;
  min_giveback?: number | null;
};

export type ExitDecision = {
  exit: boolean;
  reason: string;
  /** Soft HardInv currently beyond SL — desk should stamp/clear breach timer */
  hardinv_breaching?: boolean;
  /** Structure invalidation currently true — desk stamps structure_breach_since_ms */
  structure_breaching?: boolean;
};

/** Keep ~65% of MFE → give back at most ~35% once a real leg exists. */
export const PEAK_MFE_RETENTION = 0.72;
export const MAX_MFE_GIVEBACK = 0.35;

/**
 * Single Peak Keep for Peak trail + MindBank Soft+ belt.
 * Desk + genome share one Keep — never two Soft× dialects of "Keep".
 */
export function effectivePeakKeep(
  deskRetention: number,
  genomeKeep: number
): number {
  const fallback = getBrainGenome().peak_mfe_retention_fallback || PEAK_MFE_RETENTION;
  let peakRet = deskRetention > 0 ? deskRetention : fallback;
  if (genomeKeep > 0) {
    peakRet = Math.max(peakRet, genomeKeep);
  }
  return peakRet;
}

/**
 * Gold-scale factory defaults (reference).
 * Live Soft/Peak/Target follow desk calibration — auto-cal may move below these
 * floors when Soft-heavy losses or ease intent require it. Abs floor only
 * applies when it does not fight the Soft CAP.
 * Live paths read BrainGenome; these consts remain factory fallbacks.
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

function genomeHardinvAbsFloor(): number {
  const n = getBrainGenome().hardinv_abs_floor;
  return n > 0 ? n : HARDINV_ABS_FLOOR;
}

function genomePeakMfeAbsFloor(): number {
  const n = getBrainGenome().peak_mfe_abs_floor;
  return n > 0 ? n : PEAK_MFE_ABS_FLOOR;
}

function genomePeakMinGivebackAbs(): number {
  const n = getBrainGenome().peak_min_giveback_abs;
  return n > 0 ? n : PEAK_MIN_GIVEBACK_ABS;
}

function genomeTargetAbsFloor(): number {
  const n = getBrainGenome().target_abs_floor;
  return n > 0 ? n : TARGET_ABS_FLOOR;
}

function genomeSafetyTpMinRr(): number {
  const n = getBrainGenome().safety_tp_min_rr;
  return n > 0 ? n : SAFETY_TP_MIN_RR;
}

function genomeSafetyTpVsMinStopMult(): number {
  const n = getBrainGenome().safety_tp_vs_min_stop_mult;
  return n > 0 ? n : 1.05;
}

function genomeSafetySlCushionFrac(): number {
  return Math.max(0, getBrainGenome().safety_sl_cushion_bp) * 1e-4 || 0.002;
}

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
  const targetFloor = genomeTargetAbsFloor();
  const targetAbs = cal.target_abs > 0 ? cal.target_abs : targetFloor;
  return (
    Math.max(absEntry * cal.target_pct, scaleDeskAbs(targetAbs, absEntry)) *
    profile.target_mult
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
  if (min > 0) dist = Math.max(dist, min * genomeSafetyTpVsMinStopMult());

  const softSl = hardInvStopDistance(entry, regime);
  const cushion = Math.max(Math.abs(entry), 1e-9) * genomeSafetySlCushionFrac();
  const slRef =
    opts?.stopDistancePrice != null &&
    Number.isFinite(opts.stopDistancePrice) &&
    opts.stopDistancePrice > 0
      ? opts.stopDistancePrice
      : Math.max(softSl, cushion);
  const cal = getDeskCalibration();
  const minRr = genomeSafetyTpMinRr();
  const rr = Math.max(minRr, Number(cal.safety_tp_rr) || minRr);
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
    const minRr = genomeSafetyTpMinRr();
    const rr = Math.max(
      minRr,
      Number(getDeskCalibration().safety_tp_rr) || minRr
    );
    pts = Math.max(pts, stopDistancePts * rr);
  }
  const pillow = genomeSafetyTpVsMinStopMult();
  pts = Math.max(pts, min * pillow, min + 1e-9);
  return pts >= 10 ? Math.ceil(pts) : Math.round(pts * 100) / 100;
}

/**
 * First seconds after fill — spread settle + first pushback wick.
 * Broker SAFETY SL still protects; Soft HardInv waits.
 * Kept short so losers are not allowed to run for half a minute.
 * Live: BrainGenome.hardinv_grace_ms (factory matches this const).
 */
export const HARDINV_GRACE_MS = 12_000;
/**
 * Soft HardInv must stay breached this long (anti single-wick “magic minus”).
 * Short confirm — still debounce, but do not gift 37s of free adverse travel.
 * Live: BrainGenome.hardinv_confirm_ms.
 */
export const HARDINV_CONFIRM_MS = 5_000;
/** TimeDecay default hold (overridden per regime profile) */
export const TIMEDECAY_MIN_HOLD_MS = 12 * 60_000;
/**
 * TimeDecay must lock REAL mid edge — at least ~half Soft HardInv,
 * never +0.75 winners against −4 Soft losses.
 * Live: BrainGenome.timedecay_min_fav_abs.
 */
export const TIMEDECAY_MIN_FAV_ABS = 2.0;

function genomeHardinvGraceMs(): number {
  const n = getBrainGenome().hardinv_grace_ms;
  return Number.isFinite(n) && n >= 0 ? n : HARDINV_GRACE_MS;
}

function genomeHardinvConfirmMs(): number {
  const n = getBrainGenome().hardinv_confirm_ms;
  return Number.isFinite(n) && n >= 0 ? n : HARDINV_CONFIRM_MS;
}

function genomeTimedecayMinFavAbs(): number {
  const n = getBrainGenome().timedecay_min_fav_abs;
  return n > 0 ? n : TIMEDECAY_MIN_FAV_ABS;
}

function genomeMaxMfeGiveback(): number {
  const n = getBrainGenome().max_mfe_giveback;
  return n > 0 ? n : MAX_MFE_GIVEBACK;
}

function genomeHardinvAbsCap(): number {
  const n = getBrainGenome().hardinv_abs_cap;
  return n > 0 ? n : HARDINV_ABS_CAP;
}

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
 * Peak trail floor — genome-owned Soft× mults (not hardcoded Soft ceiling).
 * Factory peak_arm_soft_mult=1.35 / peak_trail_soft_cap_mult=1.75; Brain may evolve.
 */
export function peakTrailMfeFloor(mfeFloor: number, softSl: number, minBank: number): number {
  const softSized = Math.max(softSl, minBank);
  const g = getBrainGenome();
  const lo = softSized * Math.max(0.5, g.peak_arm_soft_mult);
  const hi = softSized * Math.max(lo / softSized, g.peak_trail_soft_cap_mult);
  if (!(mfeFloor > 0) || !Number.isFinite(mfeFloor)) return lo;
  return Math.min(hi, Math.max(lo, mfeFloor));
}

/**
 * Best favorable excursion from Capital OHLC since entry.
 * Restarts / attach lag otherwise forget the live MFE peak → Peak Keep never fires.
 */
export function peakMfeFromCandles(
  side: ExitSide,
  entry: number,
  candles: Array<{ high: number; low: number; snapshot_time_ms?: number | null }>,
  entryAtMs?: number | null
): number {
  if (!(entry > 0) || !Number.isFinite(entry) || !candles?.length) return 0;
  let best = 0;
  for (const c of candles) {
    if (
      entryAtMs != null &&
      Number.isFinite(entryAtMs) &&
      c.snapshot_time_ms != null &&
      Number.isFinite(c.snapshot_time_ms) &&
      c.snapshot_time_ms + 60_000 < entryAtMs
    ) {
      continue; // candle fully before fill
    }
    if (side === 'SELL') {
      if (Number.isFinite(c.low)) best = Math.max(best, entry - c.low);
    } else if (Number.isFinite(c.high)) {
      best = Math.max(best, c.high - entry);
    }
  }
  return best > 0 ? best : 0;
}

/**
 * Soft / Peak / Target abs knobs are tuned once at REF mid (~DESK_REF_MID).
 * Candles/regimes look the same on **every** market — only size changes.
 * Scale abs pts by entry/REF so all epics share the same % R:R.
 * One desk calibration — not per-market.
 * Live: BrainGenome.desk_ref_mid.
 */
export const DESK_REF_MID = 2000;

export function deskRefMid(): number {
  const n = getBrainGenome().desk_ref_mid;
  return n > 0 ? n : DESK_REF_MID;
}

/** Map a REF-tuned absolute (pts at REF) onto this instrument's price. */
export function scaleDeskAbs(refAbsPts: number, entry: number): number {
  const mid = Math.max(Math.abs(entry), 1e-9);
  return Math.max(refAbsPts * (mid / deskRefMid()), mid * 1e-9);
}

/**
 * Soft HardInv distance in price pts.
 * Base CAP/floor at REF, then × regime exit profile (entry thesis).
 * Without MFE → Soft L3 CAP (broker safety / sizing). Live manage uses
 * {@link layeredHardInvDistance} / {@link activeSoftStopDistance} so L1/L2
 * unlock with proven MFE — Peak/MindBank Soft× must NOT use L3 blindly.
 */
export function hardInvStopDistance(
  entry: number,
  regime?: string | null
): number {
  return layeredHardInvDistance(entry, /* mfe */ Number.POSITIVE_INFINITY, regime).dist;
}

/**
 * Active Soft HardInv for live manage — Soft× Peak / MindBank Soft+ / story-fight.
 * Soft reference tracks the Soft layer Soft HardInv would cut at NOW (by MFE),
 * not day-one Soft L3 CAP. Soft×1 of L3 while Soft cuts at L1 = Soft eats Soft+.
 */
export function activeSoftStopDistance(
  entry: number,
  mfe: number,
  regime?: string | null
): number {
  return layeredHardInvDistance(entry, Math.max(0, Number.isFinite(mfe) ? mfe : 0), regime)
    .dist;
}

/**
 * Soft HardInv with 3-layer unlock — no MFE keeps L1 tight; MFE earns L2/L3.
 */
export function layeredHardInvDistance(
  entry: number,
  mfe: number,
  regime?: string | null
): { dist: number; layer: 1 | 2 | 3; abs: number } {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const cal = getDeskCalibration();
  const g = getBrainGenome();
  const { abs, layer } = activeSoftAbs(
    Number.isFinite(mfe) ? Math.max(0, mfe) : Number.POSITIVE_INFINITY,
    cal
  );
  const pct = absEntry * cal.hardinv_pct;
  const floorAbs = Math.min(genomeHardinvAbsFloor(), abs);
  const floor = scaleDeskAbs(floorAbs, absEntry);
  const capAbs = Math.min(abs, genomeHardinvAbsCap());
  const cap = scaleDeskAbs(capAbs, absEntry);
  // Rich instruments: pct may exceed L1 abs — still capped by active layer
  let sl = Math.min(Math.max(pct * (layer / 3), floor), cap);
  const profile = regimeExitProfile(regime);
  sl *= profile.hardinv_mult;
  const postCap = Math.max(1, g.layered_soft_post_mult_cap || 1.3);
  sl = Math.min(sl, cap * postCap);
  return { dist: sl, layer, abs };
}

/** Structure invalidation grace / confirm (faster than Soft Soft — thesis broken). */
export const STRUCTURE_GRACE_MS = 8_000;
export const STRUCTURE_CONFIRM_MS = 3_000;

function genomeStructureGraceMs(): number {
  const n = getBrainGenome().structure_grace_ms;
  return Number.isFinite(n) && n >= 0 ? n : STRUCTURE_GRACE_MS;
}

function genomeStructureConfirmMs(): number {
  const n = getBrainGenome().structure_confirm_ms;
  return Number.isFinite(n) && n >= 0 ? n : STRUCTURE_CONFIRM_MS;
}

/**
 * Soft HardInv is LOSES-ONLY. After a Soft-sized MFE we do NOT move the line
 * to flat (old BE-lock) — that turned Funds greens into −£0.01…−£0.23 scratches
 * while Peak was still waiting for reverse-1m / softGate.
 *
 * Soft always cuts at −Soft. Peak/Target own banking (≥ Soft). Broker SAFETY SL
 * is the hard cushion if Soft never fires.
 */
export const BE_LOCK_FRAC = 0;
/** @deprecated Soft no longer BE-locks; kept for callers/tests. */
export const BE_LOCK_EXEC_FRAC = 0.25;

export function softLossLine(sl: number, _mfe?: number): number {
  void _mfe;
  return -sl;
}

export function beLockMinExec(sl: number): number {
  return Math.max(sl * BE_LOCK_EXEC_FRAC, sl * 1e-9);
}

/**
 * Soft profit exits (Peak / Target / TimeDecay) must bank at least Soft HardInv
 * — otherwise Funds shows +£0.01…+£0.03 vs −£0.06 Soft (inverted R:R).
 * Live: BrainGenome.min_profit_bank_soft_mult (factory 1.0).
 */
export function minProfitBank(sl: number): number {
  const mult = Math.max(0.5, getBrainGenome().min_profit_bank_soft_mult || 1);
  return Math.max(sl * mult, sl * 1e-9);
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
  quote?: ExitQuoteLegs | null,
  overrides?: ExitDecideOverrides | null
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
  const genome = getBrainGenome();
  // Single Peak Keep source: desk + genome (effectivePeakKeep) — MindBank must match
  let peakRet = effectivePeakKeep(cal.peak_retention, genome.peak_keep);
  // Genome max giveback floor — never allow more than max_mfe_giveback fraction lost
  peakRet = Math.max(peakRet, 1 - genomeMaxMfeGiveback());
  // Regime profile may only tighten Keep % (cut sooner) — never undercut desk/genome
  if (profile.peak_retention != null && profile.peak_retention > 0) {
    peakRet = Math.max(peakRet, profile.peak_retention);
  }
  if (
    overrides?.peak_retention_cfg != null &&
    Number.isFinite(overrides.peak_retention_cfg) &&
    overrides.peak_retention_cfg > 0
  ) {
    peakRet = Math.max(peakRet, overrides.peak_retention_cfg);
  }
  let minGiveback =
    scaleDeskAbs(
      cal.peak_min_giveback_abs > 0
        ? cal.peak_min_giveback_abs
        : genomePeakMinGivebackAbs(),
      absEntry
    ) * profile.peak_giveback_mult;
  if (
    overrides?.min_giveback != null &&
    Number.isFinite(overrides.min_giveback) &&
    overrides.min_giveback > 0
  ) {
    minGiveback = Math.min(minGiveback, overrides.min_giveback);
  }
  const mfe = Math.max(s.mfe, Math.max(0, fav));
  // Soft L1/L2/L3 — widen HardInv only after proven MFE (not day-one fat Soft)
  const softLayered = layeredHardInvDistance(entry, mfe, thesisRegime);
  const sl = softLayered.dist;
  const layers = readSoftTargetLayers(cal);
  const profileMult = profile.target_mult;
  const targetDists = layers.target.map((abs) => {
    const floor = scaleDeskAbs(abs, absEntry);
    const pctShare = abs / Math.max(layers.target[2]!, 1e-9);
    return Math.max(floor, absEntry * cal.target_pct * pctShare) * profileMult;
  }) as [number, number, number];
  const tp = targetDists[2]!;
  /** Peak/Target/TimeDecay — never bank below Soft loss size (active layer) */
  const minBank = minProfitBank(sl);
  const peakAbs =
    cal.peak_mfe_abs > 0 ? cal.peak_mfe_abs : genomePeakMfeAbsFloor();
  let mfeFloor =
    Math.max(absEntry * cal.peak_mfe_pct, scaleDeskAbs(peakAbs, absEntry)) *
    profile.peak_mfe_mult;
  if (
    overrides?.peak_mfe_floor != null &&
    Number.isFinite(overrides.peak_mfe_floor) &&
    overrides.peak_mfe_floor > 0
  ) {
    mfeFloor = Math.min(mfeFloor, Math.max(overrides.peak_mfe_floor, sl));
  }
  const retention =
    s.peak_retention != null
      ? s.peak_retention
      : mfe > 0
        ? Math.max(0, fav / mfe)
        : null;
  const heldMs = s.entry_at ? nowMs - new Date(s.entry_at).getTime() : 0;
  // Genome peak_arm_soft_mult / peak_trail_soft_cap_mult own Soft× trail floor
  const trailFloor = Math.max(minBank * 0.5, peakTrailMfeFloor(mfeFloor, sl, minBank));

  const wantLoss = gate === 'all' || gate === 'live_loss';
  const wantPeakOnly = gate === 'peak_protect_only';
  const wantFullProfit = gate === 'all' || gate === 'target_time';

  if (wantLoss) {
    let breaching = false;
    let structureBreaching = false;

    // 1) Structure invalidation — regime thesis dead at the zone.
    // Soft-sized only: never scratch micro-green OR micro-red (same-minute
    // −£0.06…−£0.17 SELL scratches while Soft is still ~3–4pt). Soft HardInv
    // owns shallow losers; structure may only cut Soft-sized green/red.
    const structReason = structureInvalidationReason(
      s.open_side,
      mid,
      thesisRegime,
      s.entry_zone
    );
    if (structReason && heldMs >= genomeStructureGraceMs()) {
      const softSized = execFav >= minBank || execFav <= -minBank;
      if (softSized) {
        structureBreaching = true;
        const since = s.structure_breach_since_ms;
        if (since != null && Number.isFinite(since) && since > 0) {
          if (nowMs - since >= genomeStructureConfirmMs()) {
            return {
              exit: true,
              reason: `${structReason} · held ${Math.round(heldMs / 1000)}s · family=${profile.family} · exec ${execFav.toFixed(5)}`,
              hardinv_breaching: false,
            };
          }
        }
      }
    }

    // 2) Soft HardInv — true Soft-sized losers only (never flat BE after green MFE)
    const lossLine = softLossLine(sl, mfe);
    if (heldMs >= genomeHardinvGraceMs() && fav <= lossLine) {
      breaching = true;
      const since = s.hardinv_breach_since_ms;
      if (since != null && Number.isFinite(since) && since > 0) {
        const breachedFor = nowMs - since;
        if (breachedFor >= genomeHardinvConfirmMs()) {
          return {
            exit: true,
            reason: `HardInvalidation · Soft L${softLayered.layer} · UPL ${fav.toFixed(5)} ≤ ${lossLine.toFixed(5)} (SL ${sl.toFixed(5)}) · exec ${execFav.toFixed(5)} · ${profile.family} · held ${Math.round(heldMs / 1000)}s · confirm ${Math.round(breachedFor / 1000)}s`,
            hardinv_breaching: true,
          };
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
      peakShouldCut(fav, mfe, retention, trailFloor, peakRet, minGiveback)
    ) {
      const givePct = ((1 - peakRet) * 100).toFixed(0);
      return {
        exit: true,
        reason: `PeakProtection · ${profile.family} · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} · keep≤${(peakRet * 100).toFixed(0)}% · giveback≤${givePct}% · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }
    return { exit: false, reason: '' };
  }

  if (wantFullProfit) {
    if (
      gate === 'all' &&
      execFav >= minBank &&
      peakShouldCut(fav, mfe, retention, trailFloor, peakRet, minGiveback)
    ) {
      return {
        exit: true,
        reason: `PeakProtection · ${profile.family} · retention ${(retention! * 100).toFixed(0)}% of MFE ${mfe.toFixed(5)} → lock best · keep≤${(peakRet * 100).toFixed(0)}% · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }

    if (fav >= tp && execFav >= minBank) {
      return {
        exit: true,
        reason: `Target L3 / best outcome · ${profile.family} · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)} · exec ${execFav.toFixed(5)} ≥ Soft ${sl.toFixed(5)}`,
      };
    }
    const layerHit = targetLayerHit({
      fav,
      mfe,
      execFav,
      minBank,
      targetDists,
    });
    if (layerHit && layerHit.layer < 3) {
      return {
        exit: true,
        reason: `Target L${layerHit.layer} · ${profile.family} · UPL ${fav.toFixed(5)} ≥ T${layerHit.layer} ${layerHit.dist.toFixed(5)} · MFE ${mfe.toFixed(5)} · exec ${execFav.toFixed(5)} ≥ Soft L${softLayered.layer} ${sl.toFixed(5)}`,
      };
    }

    const timedecayFavPct =
      Math.max(0, genome.timedecay_fav_pct_bp) * 1e-4 || 0.00035;
    const minFav =
      Math.max(
        scaleDeskAbs(genomeTimedecayMinFavAbs(), absEntry),
        absEntry * timedecayFavPct,
        minBank,
        scaleDeskAbs(cal.target_abs || genomeTargetAbsFloor(), absEntry) * 0.4
      ) * profile.timedecay_min_fav_mult;
    const holdNeed =
      profile.timedecay_hold_ms > 0
        ? profile.timedecay_hold_ms
        : genomeTimedecayMinHoldMs(genome);
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
  if (heldMs < genomeStructureGraceMs()) return false;
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
