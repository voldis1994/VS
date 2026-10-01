/**
 * Regime runner — hold Target T1–T3 while live regime family still matches
 * fill thesis. NOT for SIDE (RANGE/COMPRESSION/TRANSITION fade/chop).
 *
 * HardInv / Peak / MindBank Soft+ stay upstream — this only gates Target/TimeDecay.
 * Score 0…max (factory 10): every N closes auto-cal deducts or recovers.
 * Genome owns all thresholds — lot/API/system off-limits.
 */
import { getBrainGenome, type BrainGenome } from '../brainSelfImprove/brainGenome.js';
import { normalizeRegime, type RegimeName } from './regimes.js';
import { regimeExitFamily, type RegimeExitFamily } from './regimeExitProfile.js';
import { targetLayerHit } from './profitLayers.js';
import { readSoftTargetLayers } from './profitLayers.js';
import { scaleDeskAbs } from './exitManage.js';

/** Factory eligible regimes — TREND / PULLBACK / BREAKOUT / EXPANSION (no SIDE). */
export const REGIME_RUNNER_ELIGIBLE = [
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'EXPANSION',
] as const;

const SIDE_FAMILIES = new Set<RegimeExitFamily>(['fade', 'chop']);

function eligibleSet(g: BrainGenome): Set<string> {
  const list = g.regime_runner_eligible_regimes?.length
    ? g.regime_runner_eligible_regimes
    : [...REGIME_RUNNER_ELIGIBLE];
  return new Set(list.map((x) => String(x).toUpperCase()));
}

/** Entry thesis may use regime runner (not SIDEWAY fade/chop). */
export function regimeRunnerEligible(entryRegime?: string | null): boolean {
  const g = getBrainGenome();
  if (g.regime_runner_enabled === false) return false;
  const r = normalizeRegime(entryRegime);
  const fam = regimeExitFamily(r);
  if (SIDE_FAMILIES.has(fam)) return false;
  return eligibleSet(g).has(r);
}

/** Score high enough to allow hold (fallback when below). */
export function regimeRunnerScoreActive(g: BrainGenome = getBrainGenome()): boolean {
  if (g.regime_runner_enabled === false) return false;
  const score = Number(g.regime_runner_score ?? g.regime_runner_score_max ?? 10);
  const min = Number(g.regime_runner_active_min_score ?? 5);
  return score + 1e-9 >= min;
}

/**
 * Same directional family: TREND↔PULLBACK same side, BREAKOUT same side.
 * Opposite or SIDE → mismatch (release runner).
 */
export function regimeRunnerFamiliesMatch(
  entryRegime?: string | null,
  liveRegime?: string | null
): boolean {
  const entry = normalizeRegime(entryRegime);
  const live = normalizeRegime(liveRegime);
  if (!regimeRunnerEligible(entry)) return false;
  const lf = regimeExitFamily(live);
  if (SIDE_FAMILIES.has(lf)) return false;
  // Same compass only — TREND_UP must not hold through TREND_DOWN
  const up = new Set<RegimeName>(['TREND_UP', 'PULLBACK_UPTREND', 'BREAKOUT_UP']);
  const down = new Set<RegimeName>(['TREND_DOWN', 'PULLBACK_DOWNTREND', 'BREAKOUT_DOWN']);
  if (up.has(entry) && up.has(live)) return true;
  if (down.has(entry) && down.has(live)) return true;
  // EXPANSION may continue while live stays expansion / same-side trend
  if (entry === 'EXPANSION') {
    if (lf === 'expansion') return true;
    // Without side hint, expansion+trend match is too loose — require armed caller
    return false;
  }
  return false;
}

export type RegimeRunnerHoldInput = {
  entryRegime?: string | null;
  liveRegime?: string | null;
  /** Already armed this trade after T1–T3 touch */
  armed: boolean;
  fav: number;
  mfe: number;
  execFav: number;
  minBank: number;
  absEntry: number;
  /** Desk target abs (L3-ish) — layers derived from genome Soft/Target */
  targetAbs?: number | null;
};

export type RegimeRunnerHoldResult = {
  hold: boolean;
  arm: boolean;
  why: string;
  layer: number | null;
};

/**
 * Should Target/TimeDecay wait? Peak/HardInv caller must still run first.
 */
export function regimeRunnerShouldHoldTarget(
  input: RegimeRunnerHoldInput
): RegimeRunnerHoldResult {
  const g = getBrainGenome();
  if (!regimeRunnerEligible(input.entryRegime) || !regimeRunnerScoreActive(g)) {
    return { hold: false, arm: false, why: 'runner off / SIDE / score fallback', layer: null };
  }
  if (!regimeRunnerFamiliesMatch(input.entryRegime, input.liveRegime)) {
    return {
      hold: false,
      arm: false,
      why: `regime changed · live ${normalizeRegime(input.liveRegime)} ≠ thesis ${normalizeRegime(input.entryRegime)}`,
      layer: null,
    };
  }

  const layers = readSoftTargetLayers();
  const abs = Math.max(1e-9, input.absEntry);
  const t1 = scaleDeskAbs(layers.target[0]!, abs);
  const t2 = scaleDeskAbs(layers.target[1]!, abs);
  const t3 = scaleDeskAbs(
    input.targetAbs != null && input.targetAbs > 0 ? input.targetAbs : layers.target[2]!,
    abs
  );
  const hit = targetLayerHit({
    fav: input.fav,
    mfe: input.mfe,
    execFav: input.execFav,
    minBank: input.minBank,
    targetDists: [t1, t2, t3],
  });
  const minLayer = Math.max(1, Math.min(3, g.regime_runner_min_target_layer ?? 1));
  const reached =
    hit != null && hit.layer >= minLayer
      ? hit.layer
      : input.fav >= t3
        ? 3
        : input.fav >= t2
          ? 2
          : input.fav >= t1
            ? 1
            : 0;

  if (!input.armed && reached < minLayer) {
    return { hold: false, arm: false, why: 'await T1–T3 touch', layer: null };
  }

  const layer = reached > 0 ? reached : input.armed ? minLayer : null;
  return {
    hold: true,
    arm: !input.armed && reached >= minLayer,
    why: `regime runner · hold Target · thesis ${normalizeRegime(input.entryRegime)} · live ${normalizeRegime(input.liveRegime)} · T${layer ?? '—'} · score ${g.regime_runner_score}`,
    layer,
  };
}

export type RegimeRunnerCloseNote = {
  used_runner: boolean;
  /** Closed because live left thesis family (good release) */
  regime_released: boolean;
  pnl_pts: number;
  mfe: number;
};

/**
 * Evaluate runner window — returns next score + change log.
 * "Works": majority of runner closes profitable with MFE retention ≥ genome floor.
 * Fail: majority losers or gave back most of MFE.
 */
export function evaluateRegimeRunnerScore(
  notes: RegimeRunnerCloseNote[],
  g: BrainGenome = getBrainGenome()
): { score: number; change: string | null } {
  const max = g.regime_runner_score_max ?? 10;
  const min = g.regime_runner_score_floor ?? 0;
  let score = Math.max(min, Math.min(max, Number(g.regime_runner_score ?? max)));
  const runnerCloses = notes.filter((n) => n.used_runner);
  const sampleMin = g.regime_runner_sample_min ?? 1;
  if (runnerCloses.length < sampleMin) {
    return { score, change: null };
  }
  // Sanitizer owns retain bounds — no consumer Math.max/min
  const retainFloor = g.regime_runner_success_mfe_retain ?? 0.45;
  let good = 0;
  let bad = 0;
  for (const n of runnerCloses) {
    const retain = n.mfe > 1e-9 ? n.pnl_pts / n.mfe : n.pnl_pts > 0 ? 1 : 0;
    if (n.pnl_pts > 0 && retain >= retainFloor) good += 1;
    else if (
      n.pnl_pts < -1e-9 ||
      retain < retainFloor * (g.regime_runner_bad_retain_frac ?? 0.5)
    )
      bad += 1;
  }
  const deduct = g.regime_runner_deduct_pts ?? 2;
  const recover = g.regime_runner_recover_pts ?? 1;
  if (bad > good) {
    const next = Math.max(min, score - deduct);
    return {
      score: next,
      change: `regime_runner score ${score}→${next} · bad=${bad} good=${good} (deduct ${deduct})`,
    };
  }
  if (good > bad && score < max) {
    const next = Math.min(max, score + recover);
    return {
      score: next,
      change: `regime_runner score ${score}→${next} · good=${good} bad=${bad} (recover ${recover})`,
    };
  }
  return { score, change: `regime_runner score ${score} · good=${good} bad=${bad} (hold)` };
}
