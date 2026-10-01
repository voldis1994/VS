/**
 * Ultimate desk auto-calibrate — watches closes since robot START and
 * retunes Soft/HardInv (abs+pct), Peak/Target, genome Peak/Soft memory,
 * multi-TF/regime perception, and regime allowlist every N closes.
 *
 * Freedom policy: Soft/HardInv/genome/regimes/entry filters may all move for
 * better expectancy. Start OPEN TRADE-ALL; self-correct from closes + market ctx.
 * Never empty allowlist below MIN_ENABLED_REGIMES. Lot untouched.
 * WHAT/WHY change logs for GUI + LIVE LOG.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultDeskCalibration,
  getDeskCalibration,
  setDeskCalibration,
  tradableDefaultRegimes,
  type DeskCalibration,
} from './deskCalibration.js';
import { summarizeExitReason } from './tradeLedger.js';
import type { RegimeName } from './regimes.js';
import { resolveDeskClientId } from './deskClientScope.js';
import type { MarketContextCompact } from './marketContext.js';
import { reviewSessionLikeHuman } from './traderMind.js';
import {
  getBrainGenome,
  setBrainGenome,
  type BrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import {
  readSoftTargetLayers,
  suggestLayersFromExcursions,
} from './profitLayers.js';
import { evaluateRegimeRunnerScore } from './regimeRunner.js';

export const AUTO_CALIBRATE_EVERY_N = 5;
/** After an applied calibrate — space next cycle; entries stay open. */
export const AUTO_CALIBRATE_COOLDOWN_MS = 3 * 60_000;
/** Never drop below this many regimes — entries stay possible. */
export const MIN_ENABLED_REGIMES = 5;
/** Wide caps — learner explores; desk sanitize is the hard wall. */
export const AUTO_CAL_MAX_SAFETY_TP_RR = 3.0;
export const AUTO_CAL_MAX_TARGET_ABS = 12.0;
export const AUTO_CAL_MAX_PEAK_MFE_ABS = 8.0;
export const AUTO_CAL_MAX_PEAK_RETENTION = 0.95;
/** Peak Keep % — full freedom (10%…95%). Old floors 65/78% blocked real regulation. */
export const AUTO_CAL_MIN_PEAK_RETENTION = 0.1;
/** Soft HardInv CAP range — full Soft freedom. */
export const AUTO_CAL_MIN_HARDINV_ABS = 0.5;
export const AUTO_CAL_MAX_HARDINV_ABS = 8.0;
export const AUTO_CAL_MIN_HARDINV_PCT = 0.0002;
export const AUTO_CAL_MAX_HARDINV_PCT = 0.004;
export const AUTO_CAL_MIN_TARGET_PCT = 0.0008;
export const AUTO_CAL_MAX_TARGET_PCT = 0.01;
export const AUTO_CAL_MIN_PEAK_MFE_PCT = 0.0002;
export const AUTO_CAL_MAX_PEAK_MFE_PCT = 0.006;
/** After this many consecutive "raise winners" cycles with still-bad E → pull back. */
export const AUTO_CAL_RAISE_STREAK_BEFORE_PULLBACK = 2;
/** Soft CAP tighten/ease step (abs) — genome soft_tighten_step factory fallback. */
export const SOFT_TIGHTEN_STEP = 0.3;
/** Peak MFE ease step (abs) on pullback. */
export const PEAK_EASE_ABS_STEP = 0.5;
/** Peak retention ease/tighten step on pullback. */
export const PEAK_EASE_RETENTION_STEP = 0.05;
/** Peak min-giveback ease step on pullback. */
export const PEAK_EASE_GIVEBACK_STEP = 0.15;
/** SAFETY TP RR raise step when letting winners run. */
export const SAFETY_TP_RR_STEP = 0.15;
/** SAFETY TP RR pullback step when targets overreached. */
export const SAFETY_TP_RR_PULLBACK_STEP = 0.25;
/** Soft-sized loss count before Soft-heavy path arms. */
export const SOFT_SIZED_LOSS_DETECT_MIN = 2;

/** Autotune cadence — genome auto_calibrate_every_n (not literal 5). */
export function autoCalibrateEveryN(): number {
  return Math.max(2, getBrainGenome().auto_calibrate_every_n ?? AUTO_CALIBRATE_EVERY_N);
}

/** Same slice the live trigger uses after everyN closes. */
export function autoCalibrateWindowFromTrades<T>(trades: readonly T[]): T[] {
  return trades.slice(-autoCalibrateEveryN());
}

/** Live auto-cal bounds from BrainGenome (factory consts as fallbacks). pct via bp (min 0.1). */
function calBounds() {
  const g = getBrainGenome();
  // Sanitizer owns bp min 0.1 — no consumer Math.max floor
  const bp = (n: number, fb: number) => (n ?? fb) * 1e-4;
  return {
    maxSafetyRr: g.auto_cal_max_safety_tp_rr ?? AUTO_CAL_MAX_SAFETY_TP_RR,
    maxTargetAbs: g.auto_cal_max_target_abs ?? AUTO_CAL_MAX_TARGET_ABS,
    maxPeakMfeAbs: g.auto_cal_max_peak_mfe_abs ?? AUTO_CAL_MAX_PEAK_MFE_ABS,
    maxPeakRetention: g.auto_cal_max_peak_retention ?? AUTO_CAL_MAX_PEAK_RETENTION,
    minPeakRetention: g.auto_cal_min_peak_retention ?? AUTO_CAL_MIN_PEAK_RETENTION,
    minHardinvAbs: g.auto_cal_min_hardinv_abs ?? AUTO_CAL_MIN_HARDINV_ABS,
    maxHardinvAbs: g.auto_cal_max_hardinv_abs ?? AUTO_CAL_MAX_HARDINV_ABS,
    minHardinvPct: bp(g.auto_cal_min_hardinv_pct_bp, 2),
    maxHardinvPct: bp(g.auto_cal_max_hardinv_pct_bp, 40),
    minTargetPct: bp(g.auto_cal_min_target_pct_bp, 8),
    maxTargetPct: bp(g.auto_cal_max_target_pct_bp, 100),
    minPeakMfePct: bp(g.auto_cal_min_peak_mfe_pct_bp, 2),
    maxPeakMfePct: bp(g.auto_cal_max_peak_mfe_pct_bp, 60),
    softTightenStep: g.soft_tighten_step ?? SOFT_TIGHTEN_STEP,
    peakEaseAbsStep: g.peak_ease_abs_step ?? PEAK_EASE_ABS_STEP,
    peakEaseRetentionStep: g.peak_ease_retention_step ?? PEAK_EASE_RETENTION_STEP,
    peakEaseGivebackStep: g.peak_ease_giveback_step ?? PEAK_EASE_GIVEBACK_STEP,
    safetyTpRrStep: g.safety_tp_rr_step ?? SAFETY_TP_RR_STEP,
    safetyTpRrPullbackStep: g.safety_tp_rr_pullback_step ?? SAFETY_TP_RR_PULLBACK_STEP,
    minEnabledRegimes: g.min_enabled_regimes ?? MIN_ENABLED_REGIMES,
    raiseStreakBeforePullback:
      g.raise_streak_before_pullback ?? AUTO_CAL_RAISE_STREAK_BEFORE_PULLBACK,
    softSizedLossDetectMin: g.soft_sized_loss_detect_min ?? SOFT_SIZED_LOSS_DETECT_MIN,
    softSizedLossFrac: g.soft_sized_loss_frac ?? 0.65,
    maxMfeGiveback: g.max_mfe_giveback ?? 0.35,
    microWinVsLoss: g.auto_cal_micro_win_vs_loss ?? 0.45,
    highMfeVsLoss: g.auto_cal_high_mfe_vs_loss ?? 0.8,
    leftWinnerEMax: g.auto_cal_left_winner_e_max ?? 0.2,
    asymWinVsLoss: g.auto_cal_asym_win_vs_loss ?? 0.85,
    softDomEMax: g.auto_cal_soft_dom_e_max ?? 0.05,
    softDomWinVsLoss: g.auto_cal_soft_dom_win_vs_loss ?? 0.75,
    easeFilterEMin: g.auto_cal_ease_filter_e_min ?? 0.5,
    legacyRaiseEMax: g.auto_cal_legacy_raise_e_max ?? 0.15,
    legacyRaiseWinVsLoss: g.auto_cal_legacy_raise_win_vs_loss ?? 0.9,
    softTightEMax: g.auto_cal_soft_tight_e_max ?? 0.15,
    healthyEMin: g.auto_cal_healthy_e_min ?? 0.3,
    healthyWinVsLoss: g.auto_cal_healthy_win_vs_loss ?? 0.95,
    targetEaseAbs: g.auto_cal_target_ease_abs ?? 1.2,
    targetPctEaseDiv: g.auto_cal_target_pct_ease_div ?? 1.12,
    peakRaiseAbs: g.auto_cal_peak_raise_abs ?? 0.4,
    targetRaiseAbs: g.auto_cal_target_raise_abs ?? 0.8,
    targetPctRaiseMult: g.auto_cal_target_pct_raise_mult ?? 1.06,
    peakPctRaiseMult: g.auto_cal_peak_pct_raise_mult ?? 1.05,
    givebackRaiseAbs: g.auto_cal_giveback_raise_abs ?? 0.1,
    healthyKeepStep: g.auto_cal_healthy_keep_step ?? 0.01,
    letWinnersEMin: g.auto_cal_let_winners_e_min ?? 0.25,
    choppyCtxMin: g.auto_cal_choppy_ctx_min ?? 2,
    choppyEMax: g.auto_cal_choppy_e_max ?? 0.1,
    negEAlignMax: g.auto_cal_neg_e_align_max ?? -0.2,
    expandCtxMin: g.auto_cal_expand_ctx_min ?? 3,
    expandEMin: g.auto_cal_expand_e_min ?? 0.15,
    choppyDwellEMax: g.auto_cal_choppy_dwell_e_max ?? 0,
    fightCtxMin: g.auto_cal_fight_ctx_min ?? 2,
    fightEMax: g.auto_cal_fight_e_max ?? 0.05,
    softDomLossCountMin: g.auto_cal_soft_dom_loss_count_min ?? 3,
    softDomLossVsHardinv: g.auto_cal_soft_dom_loss_vs_hardinv ?? 0.7,
    demoteRecoverEMin: g.auto_cal_demote_recover_e_min ?? 0.1,
    softLossAbsFloor: g.auto_cal_soft_loss_abs_floor ?? 1.0,
    microWinAbsFloor: g.auto_cal_micro_win_abs_floor ?? 1.0,
    peakExitsMin: g.auto_cal_peak_exits_min ?? 2,
    highMfeTinyCountMin: g.auto_cal_high_mfe_tiny_count_min ?? 2,
    microWinsMin: g.auto_cal_micro_wins_min ?? 2,
    avgLossAbsFloor: g.auto_cal_avg_loss_abs_floor ?? 1.0,
    alreadyTallSoftMult: g.auto_cal_already_tall_soft_mult ?? 2.8,
    softTightSoftLossesMin: g.auto_cal_soft_tight_soft_losses_min ?? 2,
    softTightHighMfeMin: g.auto_cal_soft_tight_high_mfe_min ?? 1,
    softTightHardinvMax: g.auto_cal_soft_tight_hardinv_max ?? 2.0,
    regimePromoteNMin: g.auto_cal_regime_promote_n_min ?? 1,
    regimePromoteSumMin: g.auto_cal_regime_promote_sum_min ?? 0.4,
    regimeKeepNMax: g.auto_cal_regime_keep_n_max ?? 2,
    regimeKeepSumMin: g.auto_cal_regime_keep_sum_min ?? -0.35,
    regimeDemoteSumMax: g.auto_cal_regime_demote_sum_max ?? -0.8,
    mutSoftPlusGivebackStep: g.auto_cal_mut_soft_plus_giveback_step ?? 0.03,
    mutPeakArmStep: g.auto_cal_mut_peak_arm_step ?? 0.05,
    mutSoftLayerUnlockStep: g.auto_cal_mut_soft_layer_unlock_step ?? 0.05,
    mutPbEpisodeArmStep: g.auto_cal_mut_pb_episode_arm_step ?? 0.05,
    mutPbEpisodeMfeStep: g.auto_cal_mut_pb_episode_mfe_step ?? 0.05,
    mutSoftPlusRunnerStep: g.auto_cal_mut_soft_plus_runner_step ?? 0.05,
    mutSoftPlusLegStep: g.auto_cal_mut_soft_plus_leg_step ?? 0.05,
    mutSoftPlusGivebackMin: g.auto_cal_mut_soft_plus_giveback_min ?? 0.55,
    mutSoftPlusGivebackMax: g.auto_cal_mut_soft_plus_giveback_max ?? 0.85,
    mutPeakArmMin: g.auto_cal_mut_peak_arm_min ?? 0.5,
    mutPeakArmMax: g.auto_cal_mut_peak_arm_max ?? 2.0,
    mutSoftLayerUnlockMin: g.auto_cal_mut_soft_layer_unlock_min ?? 0.5,
    mutSoftLayerUnlockMax: g.auto_cal_mut_soft_layer_unlock_max ?? 1.5,
    mutPbEpisodeArmMin: g.auto_cal_mut_pb_episode_arm_min ?? 0.5,
    mutPbEpisodeArmMax: g.auto_cal_mut_pb_episode_arm_max ?? 1.35,
    mutPbEpisodeMfeMin: g.auto_cal_mut_pb_episode_mfe_min ?? 0.25,
    mutPbEpisodeMfeMax: g.auto_cal_mut_pb_episode_mfe_max ?? 1.0,
    mutSoftPlusRunnerMin: g.auto_cal_mut_soft_plus_runner_min ?? 1.0,
    mutSoftPlusRunnerMax: g.auto_cal_mut_soft_plus_runner_max ?? 2.0,
    mutSoftPlusLegMin: g.auto_cal_mut_soft_plus_leg_min ?? 1.0,
    mutSoftPlusLegMax: g.auto_cal_mut_soft_plus_leg_max ?? 2.0,
    rangeSoftMin: g.auto_cal_range_soft_min ?? 2,
    rangeWinsMin: g.auto_cal_range_wins_min ?? 2,
    pbSoftMin: g.auto_cal_pb_soft_min ?? 2,
    mutRangeChopDown: g.auto_cal_mut_range_chop_down ?? 0.03,
    mutRangeShareDown: g.auto_cal_mut_range_share_down ?? 0.03,
    mutRangeEffDown: g.auto_cal_mut_range_eff_down ?? 0.03,
    mutRangeChopUp: g.auto_cal_mut_range_chop_up ?? 0.02,
    mutRangeChopMin: g.auto_cal_mut_range_chop_min ?? 0.08,
    mutRangeChopMax: g.auto_cal_mut_range_chop_max ?? 0.55,
    mutRangeShareMin: g.auto_cal_mut_range_share_min ?? 0.12,
    mutRangeShareMax: g.auto_cal_mut_range_share_max ?? 0.55,
    mutRangeEffMin: g.auto_cal_mut_range_eff_min ?? 0.15,
    mutRangeEffMax: g.auto_cal_mut_range_eff_max ?? 0.7,
    sameSidePauseMax: g.auto_cal_same_side_pause_max ?? 12,
    sameSidePauseSoftMin: g.auto_cal_same_side_pause_soft_min ?? 2,
    sameSidePauseStep: g.auto_cal_same_side_pause_step ?? 1,
    choppyGreenLo: g.auto_cal_choppy_green_lo ?? 0.35,
    choppyGreenHi: g.auto_cal_choppy_green_hi ?? 0.65,
    mutTrekFlatMult: g.auto_cal_mut_trek_flat_mult ?? 1.08,
    mutTrekFlatMin: g.auto_cal_mut_trek_flat_min ?? 1.5,
    mutTrekFlatMax: g.auto_cal_mut_trek_flat_max ?? 12,
    mutStoryConfStep: g.auto_cal_mut_story_conf_step ?? 0.03,
    mutStoryConfMin: g.auto_cal_mut_story_conf_min ?? 0.35,
    mutStoryConfMax: g.auto_cal_mut_story_conf_max ?? 0.8,
    mutConfirmBarsMin: g.auto_cal_mut_confirm_bars_min ?? 1,
    mutConfirmBarsMax: g.auto_cal_mut_confirm_bars_max ?? 8,
    mutConfirmBarsStep: g.auto_cal_mut_confirm_bars_step ?? 1,
    mutDwellBarsMin: g.auto_cal_mut_dwell_bars_min ?? 2,
    mutDwellBarsMax: g.auto_cal_mut_dwell_bars_max ?? 12,
    mutDwellBarsStep: g.auto_cal_mut_dwell_bars_step ?? 1,
  };
}

/**
 * Preferred liquid regimes at factory open. May demote when consistently losing;
 * floor refill from tradable defaults keeps the robot from starving.
 */
export const CORE_ALWAYS_ON_REGIMES: readonly string[] = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'EXPANSION',
  'COMPRESSION',
  'TRANSITION',
] as const;

export function isCoreAlwaysOnRegime(regime: string): boolean {
  const g = getBrainGenome();
  const core =
    g.core_always_on_regimes?.length ? g.core_always_on_regimes : CORE_ALWAYS_ON_REGIMES;
  return core.includes(String(regime || '').toUpperCase());
}

/** Structured WHAT/WHY log for GUI + LIVE LOG. */
export function autotuneLog(what: string, why: string): string {
  return `WHAT · ${what} · WHY · ${why}`;
}

/** Clean abs pts (1 decimal) — avoid 1.4→1.3999998 no-ops / UI noise. */
function roundAbs(n: number): number {
  return Math.round(n * 10) / 10;
}
/** Clean retention / keep (2 decimals). */
function roundRet(n: number): number {
  return Math.round(n * 100) / 100;
}
/** Clean RR (2 decimals). */
function roundRr(n: number): number {
  return Math.round(n * 100) / 100;
}
/** Clean pct knobs (5 decimals) — genome trek / target_pct dust. */
function roundPct(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * Soft pct is derived from Soft abs — never independent *1.05 micro-junk (0.00080→0.00084).
 * Ref mid 2750 matches factory Soft 2.2 / 0.0008. Steps of 0.0001 only.
 */
export const SOFT_PCT_REF_MID = 2750;
export function softPctFromAbs(hardinvAbs: number): number {
  const g = getBrainGenome();
  const refMid = g.soft_pct_ref_mid ?? SOFT_PCT_REF_MID;
  const raw = Math.max(0, Number(hardinvAbs) || 0) / refMid;
  return Math.round(raw * 1e4) / 1e4;
}

/** True when a calibration knob or regime allowlist actually differs (ignores updated_at). */
function deskCalibrationMateriallyChanged(a: DeskCalibration, b: DeskCalibration): boolean {
  if (a.hardinv_abs !== b.hardinv_abs) return true;
  if (a.soft_l1_abs !== b.soft_l1_abs) return true;
  if (a.soft_l2_abs !== b.soft_l2_abs) return true;
  if (a.soft_l3_abs !== b.soft_l3_abs) return true;
  if (a.peak_mfe_abs !== b.peak_mfe_abs) return true;
  if (a.peak_retention !== b.peak_retention) return true;
  if (a.peak_min_giveback_abs !== b.peak_min_giveback_abs) return true;
  if (a.target_abs !== b.target_abs) return true;
  if (a.target_l1_abs !== b.target_l1_abs) return true;
  if (a.target_l2_abs !== b.target_l2_abs) return true;
  if (a.target_l3_abs !== b.target_l3_abs) return true;
  if (a.safety_tp_rr !== b.safety_tp_rr) return true;
  if (a.hardinv_pct !== b.hardinv_pct) return true;
  if (a.target_pct !== b.target_pct) return true;
  if (a.peak_mfe_pct !== b.peak_mfe_pct) return true;
  if (a.entry_filter_level !== b.entry_filter_level) return true;
  const ra = [...a.enabled_regimes].map((r) => String(r).toUpperCase()).sort();
  const rb = [...b.enabled_regimes].map((r) => String(r).toUpperCase()).sort();
  if (ra.length !== rb.length) return true;
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return true;
  }
  return false;
}

export type SessionTrade = {
  pnl_pts: number;
  regime: string | null;
  setup_type: string | null;
  exit_reason: string | null;
  mfe: number;
  mae: number;
  at: string;
  robot_id?: string | null;
  epic?: string | null;
  /** Market context at entry (frozen) */
  entry_ctx?: MarketContextCompact | null;
  /** Market context at exit */
  exit_ctx?: MarketContextCompact | null;
  /** Regime runner held Target past T1–T3 this trade */
  regime_runner_used?: boolean;
  /** Released because live left thesis family */
  regime_runner_released?: boolean;
};

export type AutoCalCycleRecord = {
  at: string;
  summary: string;
  changes: string[];
  applied: boolean;
  window_expectancy: number;
  window_sum_pts: number;
  closes_at_cycle: number;
  cooldown_sec: number;
};

export type AutoCalibrateStatus = {
  client_id: number;
  enabled: boolean;
  session_started_at: string | null;
  closes_in_session: number;
  closes_until_next: number;
  cycles_run: number;
  last_cycle_at: string | null;
  last_summary: string | null;
  last_changes: string[];
  /** True while post-change settle spaces the next auto-cal cycle (entries stay open) */
  cooling_down: boolean;
  cooldown_until: string | null;
  cooldown_left_s: number;
  session_sum_pts: number;
  session_expectancy_pts: number;
  session_wins: number;
  session_losses: number;
  last_window_expectancy: number | null;
  history: AutoCalCycleRecord[];
  knobs_now: {
    hardinv_abs: number;
    hardinv_pct: number;
    peak_mfe_abs: number;
    peak_retention: number;
    target_abs: number;
    target_pct: number;
    safety_tp_rr: number;
    entry_filter_level: number;
    enabled_regimes: number;
    genome_peak_keep: number;
    genome_soft_giveback: number;
    genome_pullback_episode_arm: number;
  };
};

export type AutoCalibrateProposeResult = {
  applied: boolean;
  summary: string;
  changes: string[];
  next: DeskCalibration;
  genome_patch?: Partial<BrainGenome>;
  genome_changes?: string[];
};

type SessionState = {
  started_at: string | null;
  trades: SessionTrade[];
  cycles_run: number;
  last_cycle_at: string | null;
  last_summary: string | null;
  last_changes: string[];
  /** Soft-demoted this session — can be re-promoted on positive cycles */
  demoted: Set<string>;
  cooldown_until_ms: number | null;
  last_window_expectancy: number | null;
  history: AutoCalCycleRecord[];
  /** Consecutive cycles that raised Peak/Target/TP RR */
  raise_streak: number;
};

type ClientBucket = {
  enabled: boolean;
  hydrated: boolean;
  state: SessionState;
};

const buckets = new Map<number, ClientBucket>();

function emptyState(): SessionState {
  return {
    started_at: null,
    trades: [],
    cycles_run: 0,
    last_cycle_at: null,
    last_summary: null,
    last_changes: [],
    demoted: new Set(),
    cooldown_until_ms: null,
    last_window_expectancy: null,
    history: [],
    raise_streak: 0,
  };
}

function sessionPath(clientId: number): string {
  const env = process.env.AUTO_CALIBRATE_SESSION_PATH?.trim();
  if (env && clientId <= 0) return env;
  if (clientId > 0) {
    return path.join(process.cwd(), 'data', 'auto-calibrate', `client-${clientId}.json`);
  }
  return path.join(process.cwd(), 'data', 'auto-calibrate-session.json');
}

function bucket(clientId?: number | null): ClientBucket {
  const id = resolveDeskClientId(clientId);
  let b = buckets.get(id);
  if (!b) {
    b = { enabled: true, hydrated: false, state: emptyState() };
    buckets.set(id, b);
  }
  return b;
}

function persistSession(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  try {
    const file = sessionPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = b.state;
    const payload = {
      client_id: id,
      enabled: b.enabled,
      started_at: st.started_at,
      trades: st.trades.slice(-80),
      cycles_run: st.cycles_run,
      last_cycle_at: st.last_cycle_at,
      last_summary: st.last_summary,
      last_changes: st.last_changes,
      demoted: [...st.demoted],
      cooldown_until_ms: st.cooldown_until_ms,
      last_window_expectancy: st.last_window_expectancy,
      history: st.history.slice(0, 12),
      raise_streak: st.raise_streak,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* best effort */
  }
}

function hydrateSession(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  if (b.hydrated) return;
  b.hydrated = true;
  try {
    const file = sessionPath(id);
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof raw.enabled === 'boolean') b.enabled = raw.enabled;
    const st = b.state;
    st.started_at = typeof raw.started_at === 'string' ? raw.started_at : null;
    st.trades = Array.isArray(raw.trades) ? (raw.trades as SessionTrade[]) : [];
    st.cycles_run = Number(raw.cycles_run) || 0;
    st.last_cycle_at = typeof raw.last_cycle_at === 'string' ? raw.last_cycle_at : null;
    st.last_summary = typeof raw.last_summary === 'string' ? raw.last_summary : null;
    st.last_changes = Array.isArray(raw.last_changes) ? (raw.last_changes as string[]) : [];
    st.demoted = new Set(
      Array.isArray(raw.demoted) ? (raw.demoted as string[]).map((x) => String(x)) : []
    );
    st.cooldown_until_ms =
      raw.cooldown_until_ms != null && Number.isFinite(Number(raw.cooldown_until_ms))
        ? Number(raw.cooldown_until_ms)
        : null;
    st.last_window_expectancy =
      raw.last_window_expectancy != null && Number.isFinite(Number(raw.last_window_expectancy))
        ? Number(raw.last_window_expectancy)
        : null;
    st.history = Array.isArray(raw.history) ? (raw.history as AutoCalCycleRecord[]) : [];
    st.raise_streak = Number(raw.raise_streak) || 0;
  } catch {
    /* ignore corrupt disk */
  }
}

/** Factory open — ensure ALL tradable regimes ON (trade everything). */
function ensureTradeAllRegimesOn(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  try {
    const cur = getDeskCalibration(id);
    const want = tradableDefaultRegimes();
    const have = new Set(cur.enabled_regimes.map((r) => String(r).toUpperCase()));
    let changed = false;
    for (const r of want) {
      if (!have.has(r)) {
        have.add(r);
        changed = true;
      }
    }
    if (changed) {
      setDeskCalibration(
        { enabled_regimes: [...have] as never, soft_off_regimes: [] },
        id
      );
    }
  } catch {
    /* ignore */
  }
}

/** @deprecated alias — trade-all open uses full tradable set */
function ensureCoreRegimesOn(clientId?: number | null): void {
  ensureTradeAllRegimesOn(clientId);
}

/** Snap already-overreached knobs back to caps (live sessions that climbed too far). */
function clampOverreachKnobs(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  const bounds = calBounds();
  try {
    const cur = getDeskCalibration(id);
    const patch: Partial<typeof cur> = {};
    if (cur.safety_tp_rr > bounds.maxSafetyRr) patch.safety_tp_rr = bounds.maxSafetyRr;
    if (cur.target_abs > bounds.maxTargetAbs) patch.target_abs = bounds.maxTargetAbs;
    if (cur.peak_mfe_abs > bounds.maxPeakMfeAbs) patch.peak_mfe_abs = bounds.maxPeakMfeAbs;
    if (cur.peak_retention > bounds.maxPeakRetention) {
      patch.peak_retention = bounds.maxPeakRetention;
    }
    // entry_filter_level 0–3 is free — do not snap L3 back to OPEN
    if (Object.keys(patch).length) setDeskCalibration(patch, id);
  } catch {
    /* ignore */
  }
}
void clampOverreachKnobs;

export function setAutoCalibrateEnabled(on: boolean, clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const b = bucket(id);
  b.enabled = Boolean(on);
  persistSession(id);
}

export function isAutoCalibrateEnabled(clientId?: number | null): boolean {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  return bucket(id).enabled;
}

/**
 * Factory open: Soft/Peak/Target/TP RR defaults, filters L0, ALL regimes ON,
 * wipe auto-cal watch. Use on Reset — start trading everything again.
 */
export function resetClientToOpenTradeAll(
  clientId?: number | null,
  reason = 'factory_open'
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  try {
    setDeskCalibration({ ...defaultDeskCalibration() }, id);
  } catch {
    /* ignore */
  }
  return beginAutoCalibrateSession(reason, id);
}

/** Clear watch window; always restores OPEN trade-all calibration. */
export function beginAutoCalibrateSession(
  reason = 'robot_start',
  clientId?: number | null
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const st = bucket(id).state;
  st.started_at = new Date().toISOString();
  st.trades = [];
  st.cycles_run = 0;
  st.last_cycle_at = null;
  st.last_summary = `OPEN TRADE-ALL · client ${id} · ${reason} · Soft+HardInv+genome free · all regimes`;
  st.last_changes = [
    autotuneLog(
      'factory open Soft 2.2/pct0.0008 · Peak 3 keep72% · Target 5 · TP RR 1.5 · filters 0 · all regimes',
      'Sākt no jauna — trade everything, self-correct from closes'
    ),
  ];
  st.demoted.clear();
  st.cooldown_until_ms = null;
  st.last_window_expectancy = null;
  st.history = [];
  st.raise_streak = 0;
  try {
    setDeskCalibration({ ...defaultDeskCalibration() }, id);
  } catch {
    /* ignore */
  }
  ensureTradeAllRegimesOn(id);
  persistSession(id);
  return getAutoCalibrateStatus(undefined, id);
}

/**
 * Robot START — keep the close watch (do NOT wipe counted trades).
 * Factory wipe only via SĀKT NO JAUNA / resetClientToOpenTradeAll.
 */
export function ensureAutoCalibrateSession(
  reason = 'robot_start',
  clientId?: number | null
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const st = bucket(id).state;
  if (!st.started_at) {
    st.started_at = new Date().toISOString();
    st.last_summary = `session · client ${id} · ${reason} · OPEN`;
    st.last_changes = [
      autotuneLog(`session start · ${reason}`, 'closes preserved · Soft/genome free to learn'),
    ];
    ensureTradeAllRegimesOn(id);
    persistSession(id);
  }
  return getAutoCalibrateStatus(undefined, id);
}

export function isAutoCalibrateCooldownActive(
  nowMs = Date.now(),
  clientId?: number | null
): boolean {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const until = bucket(id).state.cooldown_until_ms;
  return until != null && Number.isFinite(until) && nowMs < until;
}

export function autoCalibrateCooldownLeftSec(
  nowMs = Date.now(),
  clientId?: number | null
): number {
  const id = resolveDeskClientId(clientId);
  if (!isAutoCalibrateCooldownActive(nowMs, id)) return 0;
  const until = bucket(id).state.cooldown_until_ms;
  if (until == null) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
}

function sessionStats(clientId: number) {
  const pts = bucket(clientId).state.trades.map((t) => t.pnl_pts);
  const sum = pts.reduce((a, b) => a + b, 0);
  const wins = pts.filter((p) => p > 1e-9).length;
  const losses = pts.filter((p) => p < -1e-9).length;
  return {
    session_sum_pts: sum,
    session_expectancy_pts: pts.length ? sum / pts.length : 0,
    session_wins: wins,
    session_losses: losses,
  };
}

export function getAutoCalibrateStatus(
  nowMs?: number,
  clientId?: number | null
): AutoCalibrateStatus {
  const now = nowMs ?? Date.now();
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const st = bucket(id).state;
  const n = st.trades.length;
  const everyN = autoCalibrateEveryN();
  const mod = n % everyN;
  const until = n === 0 ? everyN : mod === 0 && n > 0 ? everyN : everyN - mod;
  const cooling = isAutoCalibrateCooldownActive(now, id);
  const left = autoCalibrateCooldownLeftSec(now, id);
  const cal = getDeskCalibration(id);
  const stats = sessionStats(id);
  let genome: BrainGenome | null = null;
  try {
    genome = getBrainGenome();
  } catch {
    genome = null;
  }
  return {
    client_id: id,
    enabled: bucket(id).enabled,
    session_started_at: st.started_at,
    closes_in_session: n,
    closes_until_next: st.started_at ? until : autoCalibrateEveryN(),
    cycles_run: st.cycles_run,
    last_cycle_at: st.last_cycle_at,
    last_summary: st.last_summary,
    last_changes: [...st.last_changes],
    cooling_down: cooling,
    cooldown_until: st.cooldown_until_ms != null ? new Date(st.cooldown_until_ms).toISOString() : null,
    cooldown_left_s: left,
    ...stats,
    last_window_expectancy: st.last_window_expectancy,
    history: st.history.slice(0, 8),
    knobs_now: {
      hardinv_abs: cal.hardinv_abs,
      hardinv_pct: cal.hardinv_pct,
      peak_mfe_abs: cal.peak_mfe_abs,
      peak_retention: cal.peak_retention,
      target_abs: cal.target_abs,
      target_pct: cal.target_pct,
      safety_tp_rr: cal.safety_tp_rr,
      entry_filter_level: cal.entry_filter_level,
      enabled_regimes: cal.enabled_regimes.length,
      genome_peak_keep: genome?.peak_keep ?? 0.75,
      genome_soft_giveback: genome?.soft_plus_giveback ?? 0.75,
      genome_pullback_episode_arm: genome?.pullback_episode_peak_arm_soft_mult ?? 1.0,
    },
  };
}

/**
 * Record one closed trade. Every AUTO_CALIBRATE_EVERY_N closes since START,
 * retunes desk + genome. Applied change starts a short settle before the next
 * auto-cal cycle — entries stay open. Never throws.
 */
export function noteClosedTradeForAutoCalibrate(
  trade: SessionTrade,
  clientId?: number | null
): AutoCalibrateProposeResult | null {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const b = bucket(id);
  const state = b.state;
  if (!b.enabled) return null;
  if (!state.started_at) {
    beginAutoCalibrateSession('first_close', id);
  }
  let pts = Number(trade.pnl_pts);
  if (!Number.isFinite(pts)) {
    pts = 0;
  }

  state.trades.push({
    ...trade,
    pnl_pts: pts,
    at: trade.at || new Date().toISOString(),
  });
  persistSession(id);

  const everyN = autoCalibrateEveryN();
  if (state.trades.length % everyN !== 0) return null;

  // Window must match trigger cadence (Genome everyN — not factory const 5)
  const window = autoCalibrateWindowFromTrades(state.trades);
  const current = getDeskCalibration(id);
  let genomeNow: BrainGenome | null = null;
  try {
    genomeNow = getBrainGenome();
  } catch {
    genomeNow = null;
  }
  const proposed = proposeAutoCalibration(current, window, state.demoted, {
    raise_streak: state.raise_streak,
    genome: genomeNow ?? undefined,
  });
  const windowSum = window.reduce((a, t) => a + t.pnl_pts, 0);
  const windowE = window.length ? windowSum / window.length : 0;
  state.last_window_expectancy = windowE;
  const at = new Date().toISOString();

  const pushHistory = (applied: boolean, cooldownSec: number) => {
    state.history.unshift({
      at,
      summary: proposed.summary,
      changes: [...proposed.changes],
      applied,
      window_expectancy: windowE,
      window_sum_pts: windowSum,
      closes_at_cycle: state.trades.length,
      cooldown_sec: cooldownSec,
    });
    if (state.history.length > 12) state.history.length = 12;
  };

  const raisedWinners = proposed.changes.some(
    (c) =>
      /peak_mfe_abs|peak_retention|target_abs|safety_tp_rr|hardinv_abs ease|hardinv_pct ease/.test(
        c
      ) && /→/.test(c) && !/pullback|tighten|ease Peak|ease Target/.test(c)
  );
  const pulledBack = proposed.changes.some(
    (c) => /pullback|ease|tighten|Soft-heavy|protect/.test(c)
  );

  const genomeApplied =
    proposed.genome_patch && Object.keys(proposed.genome_patch).length > 0
      ? (() => {
          try {
            setBrainGenome({
              ...proposed.genome_patch,
              explore_step: (genomeNow?.explore_step ?? 0) + 1,
              last_lesson: proposed.summary.slice(0, 200),
            });
            return true;
          } catch {
            return false;
          }
        })()
      : false;

  const deskApplied = proposed.applied;
  const anyApplied = deskApplied || genomeApplied;

  if (!anyApplied) {
    state.cycles_run += 1;
    state.last_cycle_at = at;
    state.last_summary = proposed.summary;
    state.last_changes = proposed.changes;
    pushHistory(false, 0);
    persistSession(id);
    return proposed;
  }

  if (pulledBack) state.raise_streak = 0;
  else if (raisedWinners) state.raise_streak += 1;
  else state.raise_streak = Math.max(0, state.raise_streak - 1);

  const saved = deskApplied ? setDeskCalibration(proposed.next, id) : current;
  for (const ch of proposed.changes) {
    const m =
      /^WHAT · regime Soft OFF (.+?) ·/.exec(ch) ||
      /^WHAT · regime OFF (.+?) ·/.exec(ch) ||
      /^regime Soft OFF (.+)$/.exec(ch) ||
      /^regime OFF (.+)$/.exec(ch);
    if (m) state.demoted.add(m[1]!.split(' ')[0]!);
    const p = /^WHAT · regime ON (.+?) ·/.exec(ch) || /^regime ON (.+)$/.exec(ch);
    if (p) state.demoted.delete(p[1]!.split(' ')[0]!);
  }
  state.cooldown_until_ms = Date.now() + AUTO_CALIBRATE_COOLDOWN_MS;
  state.cycles_run += 1;
  state.last_cycle_at = at;
  const genomeNote = genomeApplied
    ? ` · genome ${proposed.genome_changes?.length ?? 0}`
    : '';
  state.last_summary = `${proposed.summary}${genomeNote} · cal settle ${AUTO_CALIBRATE_COOLDOWN_MS / 60_000}m (entries OK)`;
  state.last_changes = [
    ...proposed.changes,
    ...(proposed.genome_changes || []),
  ];
  pushHistory(true, AUTO_CALIBRATE_COOLDOWN_MS / 1000);
  persistSession(id);
  return {
    ...proposed,
    applied: true,
    next: saved,
    changes: state.last_changes,
  };
}

function proposeGenomePatch(
  next: DeskCalibration,
  windowTrades: SessionTrade[],
  intent: string,
  softDominates: boolean,
  expectancy: number,
  softLosses: number,
  genome?: BrainGenome | null
): { patch: Partial<BrainGenome>; changes: string[] } {
  const g = genome ?? null;
  const patch: Partial<BrainGenome> = {};
  const changes: string[] = [];
  if (!g) return { patch, changes };

  const fracToBp = (frac: number) =>
    Math.round((Math.max(0, Number(frac) || 0) / 1e-4) * 10) / 10;

  // PRIMARY: desk Soft/Peak/Target/pct/SAFETY/regimes → genome SoT (not a parallel brain)
  const syncNum = (
    key: keyof BrainGenome,
    deskVal: number,
    label: string,
    why: string
  ) => {
    const cur = Number(g[key]);
    if (!Number.isFinite(deskVal) || !Number.isFinite(cur)) return;
    if (Math.abs(cur - deskVal) < 1e-9) return;
    (patch as Record<string, unknown>)[key] = deskVal;
    changes.push(
      autotuneLog(`genome ${label} ${cur}→${deskVal}`, why)
    );
  };

  syncNum('soft_l1_abs', roundAbs(next.soft_l1_abs), 'soft_l1_abs', 'desk Soft L1 → genome SoT');
  syncNum('soft_l2_abs', roundAbs(next.soft_l2_abs), 'soft_l2_abs', 'desk Soft L2 → genome SoT');
  syncNum('soft_l3_abs', roundAbs(next.soft_l3_abs), 'soft_l3_abs', 'desk Soft L3 CAP → genome SoT');
  syncNum('peak_mfe_abs', roundAbs(next.peak_mfe_abs), 'peak_mfe_abs', 'desk Peak MFE → genome SoT');
  syncNum(
    'peak_retention',
    roundRet(next.peak_retention),
    'peak_retention',
    'desk Peak retention → genome SoT'
  );
  syncNum(
    'peak_min_giveback_abs',
    roundAbs(next.peak_min_giveback_abs),
    'peak_min_giveback_abs',
    'desk Peak giveback → genome SoT'
  );
  syncNum('target_l1_abs', roundAbs(next.target_l1_abs), 'target_l1_abs', 'desk Target L1 → genome SoT');
  syncNum('target_l2_abs', roundAbs(next.target_l2_abs), 'target_l2_abs', 'desk Target L2 → genome SoT');
  syncNum('target_l3_abs', roundAbs(next.target_l3_abs), 'target_l3_abs', 'desk Target L3 → genome SoT');
  syncNum('safety_tp_rr', roundRr(next.safety_tp_rr), 'safety_tp_rr', 'desk SAFETY RR → genome SoT');
  syncNum(
    'hardinv_pct_bp',
    fracToBp(next.hardinv_pct),
    'hardinv_pct_bp',
    'desk Soft pct → genome bp SoT'
  );
  syncNum(
    'peak_mfe_pct_bp',
    fracToBp(next.peak_mfe_pct),
    'peak_mfe_pct_bp',
    'desk Peak pct → genome bp SoT'
  );
  syncNum(
    'target_pct_bp',
    fracToBp(next.target_pct),
    'target_pct_bp',
    'desk Target pct → genome bp SoT'
  );
  if (next.entry_filter_level !== g.entry_filter_level) {
    patch.entry_filter_level = next.entry_filter_level;
    changes.push(
      autotuneLog(
        `genome entry_filter_level ${g.entry_filter_level}→${next.entry_filter_level}`,
        'desk entry filter → genome SoT'
      )
    );
  }
  {
    const ra = [...g.enabled_regimes].map((r) => String(r).toUpperCase()).sort();
    const rb = [...next.enabled_regimes].map((r) => String(r).toUpperCase()).sort();
    if (ra.join(',') !== rb.join(',')) {
      patch.enabled_regimes = [...next.enabled_regimes];
      changes.push(
        autotuneLog(
          `genome enabled_regimes n=${ra.length}→${rb.length}`,
          'desk regimes ON → genome SoT'
        )
      );
    }
    const sa = [...(g.soft_off_regimes ?? [])].map((r) => String(r).toUpperCase()).sort();
    const sb = [...(next.soft_off_regimes || [])].map((r) => String(r).toUpperCase()).sort();
    if (sa.join(',') !== sb.join(',')) {
      patch.soft_off_regimes = [...(next.soft_off_regimes || [])];
      changes.push(
        autotuneLog(
          `genome soft_off_regimes n=${sa.length}→${sb.length}`,
          'desk Soft OFF → genome SoT'
        )
      );
    }
  }

  // Sync Peak Keep with desk retention (genome follows 10%…95%)
  const calB = calBounds();
  const keepTarget = roundRet(
    Math.min(calB.maxPeakRetention, Math.max(calB.minPeakRetention, next.peak_retention))
  );
  if (Math.abs(g.peak_keep - keepTarget) >= 0.01) {
    patch.peak_keep = keepTarget;
    changes.push(
      autotuneLog(
        `genome peak_keep ${roundRet(g.peak_keep).toFixed(2)}→${keepTarget.toFixed(2)}`,
        'sync with desk Peak retention'
      )
    );
  }

  if (softDominates || intent === 'protect_sooner') {
    const give = roundRet(
      Math.min(
        calB.mutSoftPlusGivebackMax,
        Math.max(calB.mutSoftPlusGivebackMin, g.soft_plus_giveback + calB.mutSoftPlusGivebackStep)
      )
    );
    if (give !== roundRet(g.soft_plus_giveback)) {
      patch.soft_plus_giveback = give;
      changes.push(
        autotuneLog(
          `genome soft_plus_giveback ${roundRet(g.soft_plus_giveback).toFixed(2)}→${give.toFixed(2)}`,
          'Soft-heavy — bank Soft+ sooner'
        )
      );
    }
    const arm = roundRet(
      Math.min(
        calB.mutPeakArmMax,
        Math.max(calB.mutPeakArmMin, g.peak_arm_soft_mult - calB.mutPeakArmStep)
      )
    );
    if (arm !== roundRet(g.peak_arm_soft_mult)) {
      patch.peak_arm_soft_mult = arm;
      changes.push(
        autotuneLog(
          `genome peak_arm_soft_mult ${roundRet(g.peak_arm_soft_mult).toFixed(2)}→${arm.toFixed(2)}`,
          'arm Peak earlier after Soft losses'
        )
      );
    }
    const unlock = roundRet(
      Math.min(
        calB.mutSoftLayerUnlockMax,
        Math.max(calB.mutSoftLayerUnlockMin, g.soft_layer_unlock_mult + calB.mutSoftLayerUnlockStep)
      )
    );
    if (unlock !== roundRet(g.soft_layer_unlock_mult)) {
      patch.soft_layer_unlock_mult = unlock;
      changes.push(
        autotuneLog(
          `genome soft_layer_unlock_mult ${roundRet(g.soft_layer_unlock_mult).toFixed(2)}→${unlock.toFixed(2)}`,
          'Soft-heavy — harder to unlock fat Soft L2/L3'
        )
      );
    }
    // Soft HardInv after TREND + bounce/dip chapter → tighten pullback-episode Soft×
    const pbSoft = windowTrades.filter((t) => {
      const er = String(t.exit_reason || '');
      if (!/HardInvalidation/i.test(er) && !(Number(t.pnl_pts) < 0)) return false;
      const ch = String(t.exit_ctx?.chapter || t.entry_ctx?.chapter || '').toUpperCase();
      const reg = String(t.regime || '').toUpperCase();
      const bounce =
        ch === 'BOUNCE_IN_SELL' ||
        ch === 'DIP_IN_RALLY' ||
        ch === 'EXHAUST_LO' ||
        ch === 'EXHAUST_HI';
      const trendish =
        reg.includes('TREND') || reg.includes('PULLBACK');
      return bounce || trendish;
    }).length;
    if (pbSoft >= calB.pbSoftMin) {
      if (!g.pullback_episode_enabled) {
        patch.pullback_episode_enabled = true;
        changes.push(
          autotuneLog(
            'genome pullback_episode_enabled false→true',
            `Soft×${pbSoft} TREND/bounce Soft — enable pullback episode`
          )
        );
      }
      const epArm = roundRet(
        Math.min(
          calB.mutPbEpisodeArmMax,
          Math.max(
            calB.mutPbEpisodeArmMin,
            g.pullback_episode_peak_arm_soft_mult - calB.mutPbEpisodeArmStep
          )
        )
      );
      if (epArm !== roundRet(g.pullback_episode_peak_arm_soft_mult)) {
        patch.pullback_episode_peak_arm_soft_mult = epArm;
        changes.push(
          autotuneLog(
            `genome pullback_episode_peak_arm_soft_mult ${roundRet(g.pullback_episode_peak_arm_soft_mult).toFixed(2)}→${epArm.toFixed(2)}`,
            `Soft×${pbSoft} bounce Soft — Peak Soft× earlier in episode`
          )
        );
      }
      const epMin = roundRet(
        Math.min(
          calB.mutPbEpisodeMfeMax,
          Math.max(
            calB.mutPbEpisodeMfeMin,
            g.pullback_episode_min_mfe_soft_mult - calB.mutPbEpisodeMfeStep
          )
        )
      );
      if (epMin !== roundRet(g.pullback_episode_min_mfe_soft_mult)) {
        patch.pullback_episode_min_mfe_soft_mult = epMin;
        changes.push(
          autotuneLog(
            `genome pullback_episode_min_mfe_soft_mult ${roundRet(g.pullback_episode_min_mfe_soft_mult).toFixed(2)}→${epMin.toFixed(2)}`,
            'sooner Soft+ bank in pullback episode'
          )
        );
      }
    }
    // False RANGE Soft knives — tighten positive RANGE chop gates (harder to call RANGE)
    const rangeSoft = windowTrades.filter((t) => {
      const reg = String(t.regime || '').toUpperCase();
      if (reg !== 'RANGE' && reg !== 'COMPRESSION' && reg !== 'TRANSITION') return false;
      return t.pnl_pts < -1e-9;
    }).length;
    if (rangeSoft >= calB.rangeSoftMin) {
      const persist = roundRet(
        Math.min(
          calB.mutRangeChopMax,
          Math.max(calB.mutRangeChopMin, g.regime_range_chop_persist_max - calB.mutRangeChopDown)
        )
      );
      if (persist !== roundRet(g.regime_range_chop_persist_max)) {
        patch.regime_range_chop_persist_max = persist;
        changes.push(
          autotuneLog(
            `genome regime_range_chop_persist_max ${roundRet(g.regime_range_chop_persist_max).toFixed(2)}→${persist.toFixed(2)}`,
            `RANGE Soft×${rangeSoft} — RANGE only tighter chop`
          )
        );
      }
      const share = roundRet(
        Math.min(
          calB.mutRangeShareMax,
          Math.max(calB.mutRangeShareMin, g.regime_range_trek_share_max - calB.mutRangeShareDown)
        )
      );
      if (share !== roundRet(g.regime_range_trek_share_max)) {
        patch.regime_range_trek_share_max = share;
        changes.push(
          autotuneLog(
            `genome regime_range_trek_share_max ${roundRet(g.regime_range_trek_share_max).toFixed(2)}→${share.toFixed(2)}`,
            'false RANGE Soft — narrower sideway trek for RANGE'
          )
        );
      }
      const eff = roundRet(
        Math.min(
          calB.mutRangeEffMax,
          Math.max(calB.mutRangeEffMin, g.regime_range_trek_eff_max - calB.mutRangeEffDown)
        )
      );
      if (eff !== roundRet(g.regime_range_trek_eff_max)) {
        patch.regime_range_trek_eff_max = eff;
        changes.push(
          autotuneLog(
            `genome regime_range_trek_eff_max ${roundRet(g.regime_range_trek_eff_max).toFixed(2)}→${eff.toFixed(2)}`,
            'false RANGE Soft — lower trek-eff ceiling for RANGE'
          )
        );
      }
    }
    const pause = Math.min(
      calB.sameSidePauseMax,
      g.soft_same_side_pause_closes + calB.sameSidePauseStep
    );
    if (pause !== g.soft_same_side_pause_closes && softLosses >= calB.sameSidePauseSoftMin) {
      patch.soft_same_side_pause_closes = pause;
      changes.push(
        autotuneLog(
          `genome soft_same_side_pause_closes ${g.soft_same_side_pause_closes}→${pause}`,
          'pause same-side after Soft chop'
        )
      );
    }
  } else if (intent === 'let_winners_run' || expectancy > calB.letWinnersEMin) {
    const arm = roundRet(
      Math.min(
        calB.mutPeakArmMax,
        Math.max(calB.mutPeakArmMin, g.peak_arm_soft_mult + calB.mutPeakArmStep)
      )
    );
    if (arm !== roundRet(g.peak_arm_soft_mult)) {
      patch.peak_arm_soft_mult = arm;
      changes.push(
        autotuneLog(
          `genome peak_arm_soft_mult ${roundRet(g.peak_arm_soft_mult).toFixed(2)}→${arm.toFixed(2)}`,
          'let winners run — Peak arms later'
        )
      );
    }
    const unlockEase = roundRet(
      Math.min(
        calB.mutSoftLayerUnlockMax,
        Math.max(calB.mutSoftLayerUnlockMin, g.soft_layer_unlock_mult - calB.mutSoftLayerUnlockStep)
      )
    );
    if (unlockEase !== roundRet(g.soft_layer_unlock_mult)) {
      patch.soft_layer_unlock_mult = unlockEase;
      changes.push(
        autotuneLog(
          `genome soft_layer_unlock_mult ${roundRet(g.soft_layer_unlock_mult).toFixed(2)}→${unlockEase.toFixed(2)}`,
          'winners — easier Soft L2/L3 unlock for runners'
        )
      );
    }
    const epArmUp = roundRet(
      Math.min(
        calB.mutPbEpisodeArmMax,
        Math.max(
          calB.mutPbEpisodeArmMin,
          g.pullback_episode_peak_arm_soft_mult + calB.mutPbEpisodeArmStep
        )
      )
    );
    if (
      g.pullback_episode_enabled &&
      epArmUp !== roundRet(g.pullback_episode_peak_arm_soft_mult) &&
      epArmUp <= roundRet(g.peak_arm_soft_mult)
    ) {
      patch.pullback_episode_peak_arm_soft_mult = epArmUp;
      changes.push(
        autotuneLog(
          `genome pullback_episode_peak_arm_soft_mult ${roundRet(g.pullback_episode_peak_arm_soft_mult).toFixed(2)}→${epArmUp.toFixed(2)}`,
          'winners — episode Peak Soft× a bit later'
        )
      );
    }
    // Winning RANGE fades — ease positive RANGE gates slightly (more true chop OK)
    const rangeWins = windowTrades.filter((t) => {
      const reg = String(t.regime || '').toUpperCase();
      return (
        (reg === 'RANGE' || reg === 'COMPRESSION') &&
        t.pnl_pts > 1e-9 &&
        /PeakProtection|MindBank|Target|TimeDecay/i.test(String(t.exit_reason || ''))
      );
    }).length;
    if (rangeWins >= calB.rangeWinsMin) {
      const persist = roundRet(
        Math.min(
          calB.mutRangeChopMax,
          Math.max(calB.mutRangeChopMin, g.regime_range_chop_persist_max + calB.mutRangeChopUp)
        )
      );
      if (persist !== roundRet(g.regime_range_chop_persist_max)) {
        patch.regime_range_chop_persist_max = persist;
        changes.push(
          autotuneLog(
            `genome regime_range_chop_persist_max ${roundRet(g.regime_range_chop_persist_max).toFixed(2)}→${persist.toFixed(2)}`,
            `RANGE wins×${rangeWins} — ease chop gate`
          )
        );
      }
    }
    const runner = roundRet(
      Math.min(
        calB.mutSoftPlusRunnerMax,
        Math.max(calB.mutSoftPlusRunnerMin, g.soft_plus_runner_mult + calB.mutSoftPlusRunnerStep)
      )
    );
    if (runner !== roundRet(g.soft_plus_runner_mult)) {
      patch.soft_plus_runner_mult = runner;
      changes.push(
        autotuneLog(
          `genome soft_plus_runner_mult ${roundRet(g.soft_plus_runner_mult).toFixed(2)}→${runner.toFixed(2)}`,
          'Soft+ bank later — runners breathe'
        )
      );
    }
    const leg = roundRet(
      Math.min(
        calB.mutSoftPlusLegMax,
        Math.max(calB.mutSoftPlusLegMin, g.soft_plus_leg_mult + calB.mutSoftPlusLegStep)
      )
    );
    if (leg !== roundRet(g.soft_plus_leg_mult)) {
      patch.soft_plus_leg_mult = leg;
      changes.push(
        autotuneLog(
          `genome soft_plus_leg_mult ${roundRet(g.soft_plus_leg_mult).toFixed(2)}→${leg.toFixed(2)}`,
          'Soft+ leg later — no Soft×1 ceiling'
        )
      );
    }
  }

  // Market context — choppy / mixed pressure → loosen trek / story bar slightly
  const choppyCtx = windowTrades.filter((t) => {
    const ctx = t.exit_ctx || t.entry_ctx;
    if (!ctx) return false;
    const midShare =
      ctx.green_share > calB.choppyGreenLo && ctx.green_share < calB.choppyGreenHi;
    return midShare && !ctx.expanding;
  }).length;
  if (choppyCtx >= calB.choppyCtxMin && expectancy < calB.choppyEMax) {
    // Trek flat is bp (min 0.1) — step 0.1, never 0.00008 dust
    const trek =
      Math.round(
        Math.min(
          calB.mutTrekFlatMax,
          Math.max(calB.mutTrekFlatMin, g.mtf_trek_flat_frac * calB.mutTrekFlatMult)
        ) * 10
      ) / 10;
    if (Math.abs(trek - g.mtf_trek_flat_frac) > 0.05) {
      patch.mtf_trek_flat_frac = trek;
      changes.push(
        autotuneLog(
          `genome mtf_trek_flat_frac ${g.mtf_trek_flat_frac.toFixed(1)}→${trek.toFixed(1)} bp`,
          `choppy pressure ×${choppyCtx} — wider FLAT trek`
        )
      );
    }
    const storyMin = roundRet(
      Math.min(
        calB.mutStoryConfMax,
        Math.max(calB.mutStoryConfMin, g.entry_story_conf_min - calB.mutStoryConfStep)
      )
    );
    if (storyMin !== roundRet(g.entry_story_conf_min)) {
      patch.entry_story_conf_min = storyMin;
      changes.push(
        autotuneLog(
          `genome entry_story_conf_min ${roundRet(g.entry_story_conf_min).toFixed(2)}→${storyMin.toFixed(2)}`,
          'allow slightly weaker story when chop dominates'
        )
      );
    }
  }

  // Bad expectancy + multi-TF fights in context → require aligned side
  if (expectancy < calB.negEAlignMax && !g.mtf_require_aligned_side) {
    patch.mtf_require_aligned_side = true;
    changes.push(
      autotuneLog(
        'genome mtf_require_aligned_side false→true',
        'negative E — demand multi-TF alignment'
      )
    );
  }

  // Expanding market pressure → slightly faster regime confirm (self-build perception)
  const expandingCtx = windowTrades.filter((t) => (t.exit_ctx || t.entry_ctx)?.expanding).length;
  if (expandingCtx >= calB.expandCtxMin && expectancy > calB.expandEMin) {
    const confirm = Math.max(
      calB.mutConfirmBarsMin,
      Math.min(calB.mutConfirmBarsMax, g.regime_confirm_bars - calB.mutConfirmBarsStep)
    );
    if (confirm !== g.regime_confirm_bars) {
      patch.regime_confirm_bars = confirm;
      changes.push(
        autotuneLog(
          `genome regime_confirm_bars ${g.regime_confirm_bars}→${confirm}`,
          `expanding market ×${expandingCtx} — faster regime confirm`
        )
      );
    }
  } else if (choppyCtx >= calB.choppyCtxMin && expectancy < calB.choppyDwellEMax) {
    const dwell = Math.max(
      calB.mutDwellBarsMin,
      Math.min(calB.mutDwellBarsMax, g.regime_min_dwell_bars + calB.mutDwellBarsStep)
    );
    if (dwell !== g.regime_min_dwell_bars) {
      patch.regime_min_dwell_bars = dwell;
      changes.push(
        autotuneLog(
          `genome regime_min_dwell_bars ${g.regime_min_dwell_bars}→${dwell}`,
          `choppy ×${choppyCtx} — longer dwell before regime switch`
        )
      );
    }
  }

  // Fight feed disagreement → HTF veto on
  const fightCtx = windowTrades.filter((t) => {
    const a = (t.exit_ctx || t.entry_ctx)?.feed_agreement;
    return a === 'FIGHT' || a === 'fight' || a === 'DISAGREE';
  }).length;
  if (fightCtx >= calB.fightCtxMin && expectancy < calB.fightEMax && !g.mtf_htf_veto) {
    patch.mtf_htf_veto = true;
    changes.push(
      autotuneLog('genome mtf_htf_veto false→true', `feed fight ×${fightCtx} — HTF veto on`)
    );
  }

  // Regime runner score — every auto-cal window (factory 5 closes); SIDE trades ignored
  if (g.regime_runner_enabled !== false) {
    const notes = windowTrades.map((t) => ({
      used_runner: Boolean(t.regime_runner_used),
      regime_released: Boolean(t.regime_runner_released),
      pnl_pts: Number(t.pnl_pts) || 0,
      mfe: Number(t.mfe) || 0,
    }));
    const evalN = Math.max(2, g.regime_runner_eval_every_n ?? AUTO_CALIBRATE_EVERY_N);
    const runnerN = notes.filter((n) => n.used_runner).length;
    const calEvery = autoCalibrateEveryN();
    if (runnerN > 0 && windowTrades.length >= Math.min(evalN, calEvery)) {
      const { score, change } = evaluateRegimeRunnerScore(notes, g);
      if (score !== g.regime_runner_score) {
        patch.regime_runner_score = score;
      }
      if (change) changes.push(autotuneLog(change, 'regime runner hold Target until regime change'));
    }
  }

  return { patch, changes };
}

/** Pure propose — unit-tested without disk. */
export function proposeAutoCalibration(
  current: DeskCalibration,
  windowTrades: SessionTrade[],
  demotedSession: Set<string> = new Set(),
  opts?: { raise_streak?: number; genome?: BrainGenome | null }
): AutoCalibrateProposeResult {
  const raiseStreak = Math.max(0, Number(opts?.raise_streak) || 0);
  const bounds = calBounds();
  const changes: string[] = [];
  if (!windowTrades.length) {
    return {
      applied: false,
      summary: 'No trades in window',
      changes: [],
      next: current,
    };
  }

  const pts = windowTrades.map((t) => t.pnl_pts);
  const sum = pts.reduce((a, b) => a + b, 0);
  const wins = pts.filter((p) => p > 1e-9);
  const losses = pts.filter((p) => p < -1e-9);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLossAbs = losses.length
    ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
    : 0;
  const expectancy = sum / windowTrades.length;
  const softFrac = getBrainGenome().soft_sized_loss_frac ?? 0.65;
  const givebackFrac = getBrainGenome().max_mfe_giveback ?? 0.35;
  const softLosses = windowTrades.filter(
    (t) =>
      /HardInvalidation|HardInv/i.test(summarizeExitReason(t.exit_reason)) &&
      t.pnl_pts < -1e-9 &&
      Math.abs(t.pnl_pts) >= Math.max(bounds.softLossAbsFloor, current.hardinv_abs * softFrac)
  ).length;
  /** Soft-sized cuts even when exit_reason is MindCut/Structure/EXTERNAL — still Soft R:R. */
  const softSizedLosses = windowTrades.filter(
    (t) =>
      t.pnl_pts < -1e-9 &&
      Math.abs(t.pnl_pts) >= Math.max(bounds.softLossAbsFloor, current.hardinv_abs * softFrac)
  ).length;
  const microWins = windowTrades.filter(
    (t) =>
      t.pnl_pts > 1e-9 &&
      t.pnl_pts < Math.max(bounds.microWinAbsFloor, avgLossAbs * bounds.microWinVsLoss)
  ).length;

  const peakExits = windowTrades.filter((t) =>
    /PeakProtection|MindBank|MindCut|TimeDecay|Target/i.test(String(t.exit_reason || ''))
  );
  const highMfeTinyPnl = windowTrades.filter(
    (t) =>
      t.mfe > 0 &&
      t.pnl_pts > 0 &&
      t.pnl_pts < t.mfe * givebackFrac &&
      t.mfe >= avgLossAbs * bounds.highMfeVsLoss
  ).length;
  const leftWinnerOnTable =
    peakExits.length >= bounds.peakExitsMin &&
    highMfeTinyPnl >= bounds.highMfeTinyCountMin &&
    expectancy < bounds.leftWinnerEMax;

  const human = reviewSessionLikeHuman(windowTrades);
  changes.push(`PRĀTS · ${human.diagnosis}`);
  changes.push(`MĀCĪBA · ${human.lesson}`);

  const next: DeskCalibration = {
    ...current,
    enabled_regimes: [...current.enabled_regimes],
    soft_off_regimes: [...(current.soft_off_regimes || [])],
  };

  const rrNow = next.safety_tp_rr || 1.5;
  const alreadyTall =
    rrNow >= bounds.maxSafetyRr - 0.01 ||
    next.target_abs >= bounds.maxTargetAbs - 0.01 ||
    next.peak_mfe_abs >= bounds.maxPeakMfeAbs - 0.01 ||
    next.target_abs >= next.hardinv_abs * bounds.alreadyTallSoftMult;

  const asymmetryBad =
    avgWin > 0 &&
    avgLossAbs > 0 &&
    avgWin < avgLossAbs * bounds.asymWinVsLoss &&
    microWins >= bounds.microWinsMin;

  const softLossMin = bounds.softSizedLossDetectMin;
  const softDominates =
    expectancy < bounds.softDomEMax &&
    avgLossAbs >= bounds.avgLossAbsFloor &&
    (wins.length === 0 || avgWin < avgLossAbs * bounds.softDomWinVsLoss) &&
    (softLosses >= softLossMin ||
      softSizedLosses >= softLossMin ||
      (losses.length >= bounds.softDomLossCountMin &&
        avgLossAbs >= current.hardinv_abs * bounds.softDomLossVsHardinv));

  const needPullBack =
    human.intent === 'ease_peak_target' ||
    softDominates ||
    (expectancy < bounds.softDomEMax &&
      (raiseStreak >= bounds.raiseStreakBeforePullback ||
        alreadyTall ||
        leftWinnerOnTable ||
        (asymmetryBad && (softLosses >= softLossMin || softSizedLosses >= softLossMin))));

  const needProtectSooner =
    human.intent === 'protect_sooner' || human.intent === 'tighten_filters';
  const needTightenFilters = human.intent === 'tighten_filters';
  const needEaseFilters =
    human.intent === 'ease_filters' ||
    (human.intent === 'let_winners_run' &&
      (current.entry_filter_level || 0) > 0 &&
      expectancy >= bounds.easeFilterEMin);

  const needBiggerWinners =
    !needPullBack &&
    !needProtectSooner &&
    human.intent === 'let_winners_run' &&
    !alreadyTall &&
    raiseStreak < bounds.raiseStreakBeforePullback;

  const needBiggerWinnersLegacy =
    !needPullBack &&
    !needProtectSooner &&
    human.intent === 'hold_course' &&
    !alreadyTall &&
    raiseStreak < bounds.raiseStreakBeforePullback &&
    (expectancy < bounds.legacyRaiseEMax ||
      (avgWin > 0 && avgLossAbs > 0 && avgWin < avgLossAbs * bounds.legacyRaiseWinVsLoss) ||
      microWins >= bounds.microWinsMin);

  const doRaise = needBiggerWinners || needBiggerWinnersLegacy;

  // Soft too tight: many Soft cuts but avg Soft distance looks small vs MFE left on table
  const softTooTight =
    !softDominates &&
    softLosses >= bounds.softTightSoftLossesMin &&
    highMfeTinyPnl >= bounds.softTightHighMfeMin &&
    expectancy < bounds.softTightEMax &&
    next.hardinv_abs <= bounds.softTightHardinvMax;

  if (needPullBack) {
    // Soft-heavy — tighten Soft CAP + pct so Soft chops cost less (live Soft follows both)
    if (softDominates) {
      const softBefore = next.hardinv_abs;
      next.hardinv_abs = Math.max(bounds.minHardinvAbs, roundAbs(softBefore - bounds.softTightenStep));
      next.hardinv_abs = Math.min(bounds.maxHardinvAbs, next.hardinv_abs);
      next.hardinv_pct = softPctFromAbs(next.hardinv_abs);
      if (next.hardinv_abs !== softBefore) {
        const mkt = windowTrades
          .map((t) => (t.exit_ctx || t.entry_ctx)?.chapter)
          .filter(Boolean)
          .slice(0, 2)
          .join('/');
        changes.push(
          autotuneLog(
            `hardinv_abs ${softBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)} Soft tighten`,
            `Soft-heavy SoftTag×${softLosses} SoftSized×${softSizedLosses} E=${expectancy.toFixed(2)} avgL=${avgLossAbs.toFixed(1)}${
              mkt ? ` · mkt ${mkt}` : ''
            }`
          )
        );
      }
    }

    const rrBefore = next.safety_tp_rr || 1.5;
    next.safety_tp_rr = Math.max(1.5, roundRr(rrBefore - bounds.safetyTpRrPullbackStep));
    if (next.safety_tp_rr !== rrBefore) {
      changes.push(
        autotuneLog(
          `safety_tp_rr ${rrBefore.toFixed(2)}→${next.safety_tp_rr.toFixed(2)} pullback`,
          'targets overreached vs Soft — shrink broker TP RR'
        )
      );
    }
    const peakBefore = next.peak_mfe_abs;
    const retBefore = next.peak_retention;
    const tgtBefore = next.target_abs;
    const easedPeak = roundAbs(next.peak_mfe_abs - bounds.peakEaseAbsStep);
    const peakFloor = roundAbs(next.hardinv_abs + 0.5);
    next.peak_mfe_abs = easedPeak >= peakFloor ? easedPeak : peakBefore;
    if (softDominates) {
      next.peak_retention = roundRet(
        Math.min(bounds.maxPeakRetention, Math.max(retBefore, retBefore + bounds.peakEaseRetentionStep))
      );
    } else {
      next.peak_retention = roundRet(
        Math.max(bounds.minPeakRetention, next.peak_retention - bounds.peakEaseRetentionStep)
      );
    }
    next.peak_min_giveback_abs = roundAbs(
      Math.max(0.5, next.peak_min_giveback_abs - bounds.peakEaseGivebackStep)
    );
    const easedTgt = roundAbs(next.target_abs - bounds.targetEaseAbs);
    const tgtFloor = roundAbs(next.hardinv_abs + 1.5);
    next.target_abs = easedTgt >= tgtFloor ? easedTgt : tgtBefore;
    next.target_pct = roundPct(
      Math.max(bounds.minTargetPct, next.target_pct / bounds.targetPctEaseDiv)
    );
    if (next.peak_mfe_abs !== peakBefore) {
      changes.push(
        autotuneLog(
          `peak_mfe_abs ${peakBefore.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)} ease`,
          'bank earlier — Peak floor Soft+0.5'
        )
      );
    }
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)} ${
            softDominates ? 'protect-sooner' : 'ease'
          }`,
          softDominates ? 'Soft eats winners — keep more of Peak MFE' : 'ease Keep for room'
        )
      );
    }
    if (next.target_abs !== tgtBefore) {
      changes.push(
        autotuneLog(
          `target_abs ${tgtBefore.toFixed(1)}→${next.target_abs.toFixed(1)} ease`,
          'Target nearer Soft so winners bank'
        )
      );
    }
    // target_pct tracks abs silently — no 0.000xx WHAT spam
  } else if (needProtectSooner) {
    const retBefore = next.peak_retention;
    // Protect sooner = keep MORE of MFE (higher Keep), free within 10%…95%
    next.peak_retention = roundRet(
      Math.min(bounds.maxPeakRetention, next.peak_retention + bounds.peakEaseRetentionStep)
    );
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)} protect-sooner`,
          'PRĀTS: protect winners sooner — raise Peak Keep'
        )
      );
    }
  } else if (doRaise) {
    // Soft may ease slightly so winners have room (Soft+HardInv free)
    if (softTooTight || human.intent === 'let_winners_run') {
      const softBefore = next.hardinv_abs;
      next.hardinv_abs = Math.min(bounds.maxHardinvAbs, roundAbs(softBefore + bounds.softTightenStep));
      next.hardinv_pct = softPctFromAbs(next.hardinv_abs);
      if (next.hardinv_abs !== softBefore) {
        changes.push(
          autotuneLog(
            `hardinv_abs ${softBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)} Soft ease`,
            'give Soft room so winners are not Soft-chopped'
          )
        );
      }
    }
    const rrBefore = next.safety_tp_rr || 1.5;
    next.safety_tp_rr = Math.min(bounds.maxSafetyRr, roundRr(rrBefore + bounds.safetyTpRrStep));
    if (next.safety_tp_rr !== rrBefore) {
      changes.push(
        autotuneLog(
          `safety_tp_rr ${rrBefore.toFixed(2)}→${next.safety_tp_rr.toFixed(2)}`,
          'let winners run — raise broker TP RR'
        )
      );
    }
    const peakBefore = next.peak_mfe_abs;
    const retBefore = next.peak_retention;
    const tgtBefore = next.target_abs;
    next.peak_mfe_abs = Math.min(
      bounds.maxPeakMfeAbs,
      roundAbs(next.peak_mfe_abs + bounds.peakRaiseAbs)
    );
    next.peak_retention = roundRet(
      Math.min(bounds.maxPeakRetention, next.peak_retention + bounds.peakEaseRetentionStep)
    );
    next.peak_min_giveback_abs = roundAbs(
      Math.min(2.0, next.peak_min_giveback_abs + bounds.givebackRaiseAbs)
    );
    next.target_abs = Math.min(
      bounds.maxTargetAbs,
      roundAbs(next.target_abs + bounds.targetRaiseAbs)
    );
    next.target_pct = roundPct(
      Math.min(bounds.maxTargetPct, next.target_pct * bounds.targetPctRaiseMult)
    );
    next.peak_mfe_pct = roundPct(
      Math.min(bounds.maxPeakMfePct, next.peak_mfe_pct * bounds.peakPctRaiseMult)
    );
    if (next.peak_mfe_abs !== peakBefore) {
      changes.push(
        autotuneLog(
          `peak_mfe_abs ${peakBefore.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)}`,
          'raise Peak arm for bigger winners'
        )
      );
    }
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)}`,
          'keep more of Peak MFE'
        )
      );
    }
    if (next.target_abs !== tgtBefore) {
      changes.push(
        autotuneLog(
          `target_abs ${tgtBefore.toFixed(1)}→${next.target_abs.toFixed(1)}`,
          'raise Soft Target'
        )
      );
    }
    // target_pct / peak_mfe_pct track abs silently — no 0.000xx WHAT spam
  }

  // Soft ease when too tight even without full raise path
  if (!needPullBack && !doRaise && softTooTight) {
    const softBefore = next.hardinv_abs;
    next.hardinv_abs = Math.min(bounds.maxHardinvAbs, roundAbs(softBefore + bounds.softTightenStep));
    next.hardinv_pct = softPctFromAbs(next.hardinv_abs);
    if (next.hardinv_abs !== softBefore) {
      changes.push(
        autotuneLog(
          `hardinv_abs ${softBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)} Soft ease`,
          'Soft too tight vs MFE left on table'
        )
      );
    }
  }

  // Healthy polish
  if (
    !doRaise &&
    !needPullBack &&
    !needProtectSooner &&
    expectancy >= bounds.healthyEMin &&
    avgWin >= avgLossAbs * bounds.healthyWinVsLoss &&
    wins.length >= losses.length
  ) {
    const retBefore = next.peak_retention;
    next.peak_retention = roundRet(
      Math.min(bounds.maxPeakRetention, next.peak_retention + bounds.healthyKeepStep)
    );
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)} hold+`,
          'healthy window — tiny Keep polish'
        )
      );
    }
  }

  // Peak above Soft CAP (never raise during pullback)
  if (!needPullBack) {
    if (next.peak_mfe_abs <= next.hardinv_abs + 0.5) {
      const b = next.peak_mfe_abs;
      next.peak_mfe_abs = Math.min(bounds.maxPeakMfeAbs, roundAbs(next.hardinv_abs + 1.5));
      if (next.peak_mfe_abs !== b) {
        changes.push(
          autotuneLog(
            `peak_mfe_abs ${b.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)} floor vs Soft`,
            'Peak must sit above Soft CAP'
          )
        );
      }
    }
    if (next.target_abs <= next.hardinv_abs + 1) {
      const b = next.target_abs;
      next.target_abs = Math.min(bounds.maxTargetAbs, roundAbs(next.hardinv_abs + 3));
      if (next.target_abs !== b) {
        changes.push(
          autotuneLog(
            `target_abs ${b.toFixed(1)}→${next.target_abs.toFixed(1)} floor vs Soft`,
            'Target must sit above Soft CAP'
          )
        );
      }
    }
  }

  // Clamp overshoot
  if (next.safety_tp_rr > bounds.maxSafetyRr) {
    const b = next.safety_tp_rr;
    next.safety_tp_rr = bounds.maxSafetyRr;
    changes.push(
      autotuneLog(
        `safety_tp_rr ${b.toFixed(2)}→${next.safety_tp_rr.toFixed(2)} cap`,
        'auto-cal max TP RR'
      )
    );
  }
  if (next.target_abs > bounds.maxTargetAbs) {
    const b = next.target_abs;
    next.target_abs = bounds.maxTargetAbs;
    changes.push(
      autotuneLog(`target_abs ${b.toFixed(1)}→${next.target_abs.toFixed(1)} cap`, 'auto-cal max Target')
    );
  }
  if (next.peak_mfe_abs > bounds.maxPeakMfeAbs) {
    const b = next.peak_mfe_abs;
    next.peak_mfe_abs = bounds.maxPeakMfeAbs;
    changes.push(
      autotuneLog(`peak_mfe_abs ${b.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)} cap`, 'auto-cal max Peak')
    );
  }
  if (next.peak_retention > bounds.maxPeakRetention) {
    const b = next.peak_retention;
    next.peak_retention = bounds.maxPeakRetention;
    changes.push(
      autotuneLog(
        `peak_retention ${b.toFixed(2)}→${next.peak_retention.toFixed(2)} cap`,
        'auto-cal max Keep'
      )
    );
  }
  if (next.peak_retention < bounds.minPeakRetention) {
    const b = next.peak_retention;
    next.peak_retention = bounds.minPeakRetention;
    changes.push(
      autotuneLog(
        `peak_retention ${b.toFixed(2)}→${next.peak_retention.toFixed(2)} floor`,
        'auto-cal min Keep 10%'
      )
    );
  }
  next.hardinv_abs = Math.min(
    bounds.maxHardinvAbs,
    Math.max(bounds.minHardinvAbs, next.hardinv_abs)
  );
  // Soft pct always follows Soft abs (clean 0.0001 steps) — never *1.05 dust
  next.hardinv_pct = Math.min(
    bounds.maxHardinvPct,
    Math.max(bounds.minHardinvPct, softPctFromAbs(next.hardinv_abs))
  );

  // Entry filters L0–L3 — full freedom (tighten on knife/chop, ease when winning)
  {
    const b = Math.max(0, Math.min(3, Math.round(Number(next.entry_filter_level) || 0)));
    let lvl = b;
    if (needTightenFilters && lvl < 3) {
      lvl = Math.min(3, lvl + 1);
      changes.push(
        autotuneLog(
          `entry_filter_level ${b}→${lvl}`,
          'knife/chop Soft entries — tighten FLIP/structure filters'
        )
      );
    } else if (needEaseFilters && lvl > 0) {
      lvl = Math.max(0, lvl - 1);
      changes.push(
        autotuneLog(
          `entry_filter_level ${b}→${lvl}`,
          'positive window — ease filters toward OPEN'
        )
      );
    }
    next.entry_filter_level = lvl;
  }

  // --- Regime book: any regime may demote with evidence; floor keeps trading ---
  const byRegime = new Map<string, { sum: number; n: number }>();
  for (const t of windowTrades) {
    const r = String(t.regime || 'UNKNOWN').toUpperCase();
    if (r === 'UNKNOWN') continue;
    const cur = byRegime.get(r) || { sum: 0, n: 0 };
    cur.sum += t.pnl_pts;
    cur.n += 1;
    byRegime.set(r, cur);
  }

  let enabled = new Set(next.enabled_regimes.map((r) => String(r).toUpperCase()));
  let softOff = new Set(
    (next.soft_off_regimes || []).map((r) => String(r).toUpperCase())
  );

  for (const [r, st] of byRegime) {
    if (
      st.n >= bounds.regimePromoteNMin &&
      st.sum > bounds.regimePromoteSumMin &&
      !enabled.has(r)
    ) {
      enabled.add(r);
      softOff.delete(r);
      demotedSession.delete(r);
      changes.push(autotuneLog(`regime ON ${r}`, `winner sum=${st.sum.toFixed(1)} n=${st.n}`));
    }
  }

  let demotedThisCycle: string | null = null;
  // Prefer satellites first; cores only with stronger evidence (n≥2, sum<-0.8)
  const offenders = [...byRegime.entries()]
    .filter(([r, st]) => {
      if (st.n < bounds.regimeKeepNMax || st.sum >= bounds.regimeKeepSumMin) return false;
      if (isCoreAlwaysOnRegime(r)) return st.sum < bounds.regimeDemoteSumMax;
      return true;
    })
    .sort((a, b) => {
      const aCore = isCoreAlwaysOnRegime(a[0]) ? 1 : 0;
      const bCore = isCoreAlwaysOnRegime(b[0]) ? 1 : 0;
      if (aCore !== bCore) return aCore - bCore;
      return a[1].sum - b[1].sum;
    });
  if (offenders.length && enabled.size > bounds.minEnabledRegimes) {
    const worst = offenders[0]![0];
    if (enabled.has(worst) && enabled.size - 1 >= bounds.minEnabledRegimes) {
      enabled.delete(worst);
      demotedSession.add(worst);
      demotedThisCycle = worst;
      softOff.add(worst);
      const coreNote = isCoreAlwaysOnRegime(worst) ? ' (was preferred)' : '';
      changes.push(
        autotuneLog(
          `regime Soft OFF ${worst}${coreNote}`,
          `loser sum=${byRegime.get(worst)!.sum.toFixed(1)} n=${byRegime.get(worst)!.n} · strong signal may still enter`
        )
      );
    }
  }

  if ((expectancy > bounds.demoteRecoverEMin || !demotedThisCycle) && demotedSession.size) {
    const candidate = [...demotedSession].find((r) => r !== demotedThisCycle);
    if (candidate && !enabled.has(candidate)) {
      enabled.add(candidate);
      softOff.delete(candidate);
      demotedSession.delete(candidate);
      changes.push(
        autotuneLog(`regime ON ${candidate}`, 're-promote after positive/flat cycle')
      );
    }
  }

  // Floor: never starve — refill from tradable defaults
  if (enabled.size < bounds.minEnabledRegimes) {
    for (const r of tradableDefaultRegimes()) {
      if (enabled.size >= bounds.minEnabledRegimes) break;
      if (!enabled.has(r)) {
        enabled.add(r);
        softOff.delete(r);
        changes.push(autotuneLog(`regime ON ${r}`, 'floor — keep trading possible'));
      }
    }
  }

  // Soft OFF cannot overlap ON
  for (const r of enabled) softOff.delete(r);

  next.enabled_regimes = [...enabled] as RegimeName[];
  next.soft_off_regimes = [...softOff] as RegimeName[];

  // Snap all numeric knobs to clean decimals — real steps, no float dust
  next.hardinv_abs = roundAbs(next.hardinv_abs);
  next.peak_mfe_abs = roundAbs(next.peak_mfe_abs);
  next.target_abs = roundAbs(next.target_abs);
  next.peak_min_giveback_abs = roundAbs(next.peak_min_giveback_abs);
  next.peak_retention = roundRet(next.peak_retention);
  next.safety_tp_rr = roundRr(next.safety_tp_rr);
  next.hardinv_pct = Math.min(
    bounds.maxHardinvPct,
    Math.max(bounds.minHardinvPct, softPctFromAbs(next.hardinv_abs))
  );
  next.target_pct = roundPct(
    Math.min(bounds.maxTargetPct, Math.max(bounds.minTargetPct, next.target_pct))
  );
  next.peak_mfe_pct = roundPct(
    Math.min(bounds.maxPeakMfePct, Math.max(bounds.minPeakMfePct, next.peak_mfe_pct))
  );

  // Soft×3 + Target×3 — calibrate L1/L2 from MFE/Soft-loss; L3 stays tuned hardinv/target
  {
    const before = readSoftTargetLayers(next);
    const mfes = windowTrades.map((t) => Math.max(0, Number(t.mfe) || 0));
    const lossAbs = windowTrades
      .filter((t) => t.pnl_pts < -1e-9)
      .map((t) => Math.abs(t.pnl_pts));
    const suggested = suggestLayersFromExcursions(mfes, lossAbs, before);
    const softL3 = roundAbs(next.hardinv_abs);
    const tgtL3 = roundAbs(next.target_abs);
    let softL1 = roundAbs(before.soft[0]! * 0.55 + suggested.soft[0]! * 0.45);
    let softL2 = roundAbs(before.soft[1]! * 0.55 + suggested.soft[1]! * 0.45);
    softL1 = Math.min(softL1, softL3);
    softL2 = Math.min(Math.max(softL2, softL1), softL3);
    let tgtL1 = roundAbs(before.target[0]! * 0.55 + suggested.target[0]! * 0.45);
    let tgtL2 = roundAbs(before.target[1]! * 0.55 + suggested.target[1]! * 0.45);
    tgtL1 = Math.max(Math.min(tgtL1, tgtL3), softL1);
    tgtL2 = Math.max(Math.min(Math.max(tgtL2, tgtL1), tgtL3), softL2);
    next.soft_l1_abs = softL1;
    next.soft_l2_abs = softL2;
    next.soft_l3_abs = softL3;
    next.hardinv_abs = softL3;
    next.target_l1_abs = tgtL1;
    next.target_l2_abs = tgtL2;
    next.target_l3_abs = tgtL3;
    next.target_abs = tgtL3;
    if (
      next.soft_l1_abs !== before.soft[0] ||
      next.soft_l2_abs !== before.soft[1] ||
      next.target_l1_abs !== before.target[0] ||
      next.target_l2_abs !== before.target[1]
    ) {
      changes.push(
        autotuneLog(
          `Soft layers ${before.soft[0]!.toFixed(1)}/${before.soft[1]!.toFixed(1)}/${before.soft[2]!.toFixed(1)}→${next.soft_l1_abs.toFixed(1)}/${next.soft_l2_abs.toFixed(1)}/${next.soft_l3_abs.toFixed(1)} · Target ${before.target[0]!.toFixed(1)}/${before.target[1]!.toFixed(1)}/${before.target[2]!.toFixed(1)}→${next.target_l1_abs.toFixed(1)}/${next.target_l2_abs.toFixed(1)}/${next.target_l3_abs.toFixed(1)}`,
          '3 Soft + 3 Target — L1/L2 from MFE/Soft-loss · L3 = Soft CAP / Target CAP'
        )
      );
    }
  }

  const genomeResult = proposeGenomePatch(
    next,
    windowTrades,
    human.intent,
    softDominates,
    expectancy,
    softLosses,
    opts?.genome
  );

  const paramOrRegimeChanged = deskCalibrationMateriallyChanged(current, next);
  const genomeChanged = Object.keys(genomeResult.patch).length > 0;
  const summary =
    `n=${windowTrades.length} E=${expectancy.toFixed(2)} ` +
    `W/L=${wins.length}/${losses.length} avgW=${avgWin.toFixed(2)} avgL=${avgLossAbs.toFixed(2)}` +
    (paramOrRegimeChanged || genomeChanged
      ? ` · ${changes.length + genomeResult.changes.length} tweaks`
      : ' · hold');

  return {
    applied: paramOrRegimeChanged,
    summary,
    changes,
    next,
    genome_patch: genomeChanged ? genomeResult.patch : undefined,
    genome_changes: genomeChanged ? genomeResult.changes : undefined,
  };
}

/** Test helper — wipe session state. */
export function _resetAutoCalibrateForTests(clientId: number = 0): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  b.enabled = true;
  b.hydrated = true;
  b.state = emptyState();
  try {
    const file = sessionPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  for (const other of [0, 1, 2, 7, 99]) {
    if (other === id) continue;
    if (buckets.has(other)) {
      const ob = bucket(other);
      ob.enabled = true;
      ob.hydrated = true;
      ob.state = emptyState();
    }
  }
}
