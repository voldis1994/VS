/**
 * Adaptive manage brain — the "last click" that weighs live context and
 * decides HOLD / TRAIL / CUT / BANK.
 *
 * Soft HardInv + Soft-sized structure remain sacred (never delayed / widened).
 * Brain owns Soft-sized green banks: BANK/CUT execute closes — not only Peak nudge.
 */
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';
import { thesisFailureReason, type ExitSide } from './exitManage.js';
import {
  pressureFightsSide,
  storyFightsSide,
  type MarketContextSnapshot,
} from './marketContext.js';
import { thinkLikeTrader } from './traderMind.js';
import { learnerChooseAction, type LearnerFeatures } from './deskLearner.js';

export type ManageBrainAction = 'HOLD' | 'TRAIL' | 'CUT' | 'BANK';

/**
 * When mind says BANK/CUT on Soft-sized executable green — close now.
 * Soft HardInv still owns losers; mind never market-closes red.
 */
export function mindOwnsGreenExit(opts: {
  action: ManageBrainAction | string | null | undefined;
  execFav: number;
  softSl: number;
}): { exit: true; tag: 'MindBank' | 'MindCut' } | { exit: false } {
  const soft = Math.max(opts.softSl, 1e-9);
  const exec = opts.execFav;
  if (!(exec >= soft)) return { exit: false };
  const a = String(opts.action || '').toUpperCase();
  if (a === 'BANK') return { exit: true, tag: 'MindBank' };
  if (a === 'CUT') return { exit: true, tag: 'MindCut' };
  return { exit: false };
}

export type ManageBrainInput = {
  open_side: ExitSide;
  entry_price: number;
  mid: number;
  mfe: number;
  mae: number;
  unrealized: number;
  peak_retention: number | null;
  peak_protect_armed: boolean;
  entry_regime: string | null;
  live_regime: string | null;
  entry_setup: string | null;
  soft_sl: number;
  peak_mfe_floor: number;
  peak_retention_cfg: number;
  target_dist: number;
  minute_policy: 'continue' | 'reverse' | 'wait' | 'unknown';
  soft_gate_allow: boolean;
  soft_gate_hold_reason: string;
  next_entry_side: ExitSide | null;
  session_expectancy_pts: number;
  last_window_expectancy: number | null;
  closes_in_session: number;
  held_ms: number;
  /** Live mega market context (30m zone/story/pressure/feed/velocity) */
  market?: MarketContextSnapshot | null;
  /** Frozen at fill — compare drift */
  entry_market?: MarketContextSnapshot | null;
  /** Per-client online learner */
  client_id?: number | null;
};

export type ManageBrainResult = {
  action: ManageBrainAction;
  score: number;
  reason: string;
  /** null = leave softGate alone; true = allow Target; false = force HOLD */
  soft_gate_override: boolean | null;
  /** Peak retention threshold override (higher = cut earlier) */
  peak_retention_override: number | null;
  /** Peak MFE floor override (lower = arm/cut sooner) */
  peak_mfe_floor_override: number | null;
  force_peak_arm: boolean;
  /** Features snapshot for online learning at close */
  learner_features?: LearnerFeatures;
};

export type ManageBrainApply = {
  softGateAllow: boolean;
  peakArmed: boolean;
  peakRetentionCfg: number | null;
  peakMfeFloor: number | null;
  action: ManageBrainAction;
  reason: string;
};

const MIN_SAMPLE = 3;

/** Factory fallbacks for manage score weights (= prior hardcode) */
export const MANAGE_SCORE_SESSION_E_NEG = 0.7;
export const MANAGE_SCORE_SESSION_E_POS = 0.35;
export const MANAGE_SCORE_WINDOW_E_NEG = 0.55;
export const MANAGE_SCORE_PATH_SOFT_GREEN = 0.25;
export const MANAGE_SCORE_PATH_GIVEBACK = 0.9;
export const MANAGE_SCORE_M1_REVERSE = 0.95;
export const MANAGE_SCORE_M1_CONTINUE = 0.85;
export const MANAGE_SCORE_NEXT_ENTRY_OPP = 0.7;
export const MANAGE_SCORE_THESIS_FIGHT = 0.55;
export const MANAGE_SCORE_CLAMP = 2.5;
/** @deprecated One-brain: Learner never overrides manage action (features only). */
export const MANAGE_LEARNER_OVERRIDE_MARGIN = 0.08;
export const SESSION_E_BANK_HI = 0.25;
export const SESSION_E_BANK_LO = -0.15;
export const PRESSURE_WITH_US_BUY = 0.58;
export const PRESSURE_WITH_US_SELL = 0.42;
export const NEAR_TARGET_LEAN_BANK = 0.85;
export const PEAK_MFE_FLOOR_EASE = 0.85;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Score open-trade context → adaptive action.
 * Positive score leans BANK/CUT (take profit / protect); negative leans HOLD/TRAIL.
 */
export function scoreManageAction(input: ManageBrainInput): ManageBrainResult {
  const soft = Math.max(input.soft_sl, 1e-9);
  const mfe = Math.max(0, input.mfe);
  const mae = Math.max(0, input.mae);
  const upl = input.unrealized;
  const g = getBrainGenome();
  const minSample = Math.max(1, g.manage_min_sample || MIN_SAMPLE);
  const sessionELo = g.session_e_bank_lo ?? SESSION_E_BANK_LO;
  const sessionEHi = g.session_e_bank_hi || SESSION_E_BANK_HI;
  const wSessionNeg = g.manage_score_session_e_neg || MANAGE_SCORE_SESSION_E_NEG;
  const wSessionPos = g.manage_score_session_e_pos || MANAGE_SCORE_SESSION_E_POS;
  const wWindowNeg = g.manage_score_window_e_neg || MANAGE_SCORE_WINDOW_E_NEG;
  const wPathGreen = g.manage_score_path_soft_green || MANAGE_SCORE_PATH_SOFT_GREEN;
  const wGiveback = g.manage_score_path_giveback || MANAGE_SCORE_PATH_GIVEBACK;
  const wM1Rev = g.manage_score_m1_reverse || MANAGE_SCORE_M1_REVERSE;
  const wM1Cont = g.manage_score_m1_continue || MANAGE_SCORE_M1_CONTINUE;
  const wNextOpp = g.manage_score_next_entry_opp || MANAGE_SCORE_NEXT_ENTRY_OPP;
  const wThesis = g.manage_score_thesis_fight || MANAGE_SCORE_THESIS_FIGHT;
  const scoreClamp = g.manage_score_clamp || MANAGE_SCORE_CLAMP;
  const pressureBuy = g.pressure_with_us_buy || PRESSURE_WITH_US_BUY;
  const pressureSell = g.pressure_with_us_sell || PRESSURE_WITH_US_SELL;
  const nearTarget = g.near_target_lean_bank || NEAR_TARGET_LEAN_BANK;
  const peakEase = g.peak_mfe_floor_ease || PEAK_MFE_FLOOR_EASE;
  const cutRetention = g.mind_cut_retention || 0.55;
  const retention =
    input.peak_retention != null && Number.isFinite(input.peak_retention)
      ? input.peak_retention
      : mfe > 0
        ? Math.max(0, upl / mfe)
        : 1;

  let score = 0;
  const bits: string[] = [];

  // --- Expectancy memory (needs a few closes) ---
  const sampleOk = input.closes_in_session >= minSample;
  const sessionE = sampleOk ? input.session_expectancy_pts : 0;
  const windowE =
    sampleOk && input.last_window_expectancy != null
      ? input.last_window_expectancy
      : null;
  if (sampleOk) {
    if (sessionE < sessionELo) {
      score += wSessionNeg;
      bits.push(`sessionE ${sessionE.toFixed(2)} weak → protect`);
    } else if (sessionE > sessionEHi) {
      score -= wSessionPos;
      bits.push(`sessionE ${sessionE.toFixed(2)} strong → let run`);
    }
    if (windowE != null && windowE < (g.session_expectancy_cut ?? -0.2)) {
      score += wWindowNeg;
      bits.push(`windowE ${windowE.toFixed(2)} → bank sooner`);
    }
  }

  // --- Live path quality (Soft× from genome near_target_lean_bank) ---
  const deepGreenSoft = Math.max(0.5, Math.min(1, nearTarget));
  const fadeSoft = Math.max(0.05, 1 - deepGreenSoft);
  if (mfe >= soft) {
    bits.push(`Soft-MFE ${mfe.toFixed(2)}`);
    if (upl >= soft * deepGreenSoft) {
      score -= wPathGreen;
      bits.push('deep green');
    } else if (upl > 0 && retention < cutRetention) {
      score += wGiveback;
      bits.push(`giveback ret=${(retention * 100).toFixed(0)}%`);
    } else if (upl <= soft * fadeSoft && upl > 0) {
      score += 0.75;
      bits.push('green fading → Soft');
    }
  } else if (mfe > soft * 0.4 && upl < soft * fadeSoft) {
    score += 0.2;
    bits.push('sub-Soft stall');
  }

  if (mae >= soft * deepGreenSoft && upl > 0) {
    score += 0.45;
    bits.push(`MAE ${mae.toFixed(2)} deep then green`);
  }

  // --- Market change / thesis ---
  if (input.minute_policy === 'continue') {
    score -= wM1Cont;
    bits.push('1m continue');
  } else if (input.minute_policy === 'reverse') {
    score += wM1Rev;
    bits.push('1m reverse');
  } else if (input.minute_policy === 'wait') {
    score += 0.15;
    bits.push('1m wait');
  }

  if (input.next_entry_side && input.next_entry_side !== input.open_side) {
    score += wNextOpp;
    bits.push(`next ${input.next_entry_side} vs open`);
  } else if (input.next_entry_side && input.next_entry_side === input.open_side) {
    score -= 0.55;
    bits.push('next same-side');
  }

  const thesisFail = thesisFailureReason(input.open_side, input.live_regime);
  if (thesisFail) {
    score += wThesis + 0.25;
    bits.push(thesisFail.replace('ThesisFailure · ', 'thesis '));
  } else if (
    input.entry_regime &&
    input.live_regime &&
    input.entry_regime !== input.live_regime &&
    input.live_regime !== 'UNKNOWN'
  ) {
    score += 0.25;
    bits.push(`regime ${input.entry_regime}→${input.live_regime}`);
  }

  if (input.soft_gate_allow) {
    score += 0.2;
    bits.push('softGate open');
  }

  // --- Mega market context (30m story / pressure / velocity / feed) ---
  const mkt = input.market;
  if (mkt) {
    bits.push(mkt.summary);
    if (storyFightsSide(mkt.story?.allow, input.open_side)) {
      score += 0.85;
      bits.push(`story fights (${mkt.story?.chapter})`);
    } else if (
      mkt.story?.allow === input.open_side ||
      mkt.story?.allow === 'BOTH'
    ) {
      score -= 0.35;
      bits.push('story with us');
    }
    if (pressureFightsSide(mkt.pressure.green_share, input.open_side)) {
      score += wThesis;
      bits.push(
        `pressure G${mkt.pressure.green_1m}/R${mkt.pressure.red_1m} against`
      );
    } else if (
      (input.open_side === 'BUY' && mkt.pressure.green_share >= pressureBuy) ||
      (input.open_side === 'SELL' && mkt.pressure.green_share <= pressureSell)
    ) {
      score -= 0.4;
      bits.push('pressure with us');
    }
    if (mkt.velocity.expanding && mkt.velocity.moving) {
      if (input.minute_policy === 'continue') {
        score -= 0.35;
        bits.push('EXPAND continue');
      } else if (input.minute_policy === 'reverse') {
        score += 0.45;
        bits.push('EXPAND reverse → protect');
      }
    }
    if (mkt.feed?.agreement === 'DIVERGENT') {
      score += 0.5;
      bits.push('feed DIVERGENT');
    } else if (mkt.feed?.agreement === 'STRONG') {
      score -= 0.15;
    }
    const entryM = input.entry_market;
    if (
      entryM?.story?.chapter &&
      mkt.story?.chapter &&
      entryM.story.chapter !== mkt.story.chapter
    ) {
      score += 0.35;
      bits.push(`chapter ${entryM.story.chapter}→${mkt.story.chapter}`);
    }
  }

  // Near Target → lean BANK when market already changed
  if (upl >= input.target_dist * nearTarget && input.soft_gate_allow) {
    score += 0.4;
    bits.push('near Target');
  }

  score = clamp(score, -scoreClamp, scoreClamp);

  // --- ONE BRAIN: Mind/Genome decides. Learner features only (no action override). ---
  const learned = learnerChooseAction(input, input.client_id);
  const thought = thinkLikeTrader(input);
  const action = thought.decision;

  let soft_gate_override: boolean | null = null;
  let peak_retention_override: number | null = null;
  let peak_mfe_floor_override: number | null = null;
  let force_peak_arm = false;

  const marketChanged =
    input.minute_policy === 'reverse' ||
    Boolean(input.next_entry_side && input.next_entry_side !== input.open_side) ||
    Boolean(thesisFail);

  // Soft× arm threshold is genome-owned (Soft×1 was a hidden Soft ceiling)
  const armNeed = soft * Math.max(0.5, g.peak_arm_soft_mult);
  if (action === 'BANK') {
    soft_gate_override = true;
    force_peak_arm = true;
    // Respect desk/genome Keep 0.10–0.95 — do NOT force 0.72–0.88 Mind hardcode
    peak_retention_override = clamp(input.peak_retention_cfg, 0.1, 0.95);
  } else if (action === 'CUT') {
    force_peak_arm = true;
    peak_retention_override = clamp(input.peak_retention_cfg, 0.1, 0.95);
    peak_mfe_floor_override = Math.max(soft, input.peak_mfe_floor * peakEase);
  } else if (action === 'HOLD') {
    soft_gate_override = false;
    if (mfe >= armNeed) force_peak_arm = true;
  } else {
    force_peak_arm = mfe >= armNeed || input.peak_protect_armed;
    if (!input.soft_gate_allow && !marketChanged) soft_gate_override = false;
  }

  const reason = `${thought.spoken} · ${thought.thesis.slice(0, 90)}${
    thought.thesis.length > 90 ? '…' : ''
  } · E ${score.toFixed(2)}`;

  return {
    action,
    score,
    reason,
    soft_gate_override,
    peak_retention_override,
    peak_mfe_floor_override,
    force_peak_arm,
    learner_features: learned.features,
  };
}

export function applyManageBrainToExit(opts: {
  brain: ManageBrainResult;
  softGateAllow: boolean;
  peakArmed: boolean;
  peakRetentionCfg: number;
  peakMfeFloor: number;
}): ManageBrainApply {
  const { brain } = opts;
  let softGateAllow = opts.softGateAllow;
  if (brain.soft_gate_override === true) softGateAllow = true;
  if (brain.soft_gate_override === false) softGateAllow = false;

  return {
    softGateAllow,
    peakArmed: opts.peakArmed || brain.force_peak_arm,
    peakRetentionCfg: brain.peak_retention_override,
    peakMfeFloor: brain.peak_mfe_floor_override,
    action: brain.action,
    reason: brain.reason,
  };
}
