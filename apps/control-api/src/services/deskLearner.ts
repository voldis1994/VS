/**
 * DeskLearner — specialized online policy, designed to beat general LLMs at
 * THIS desk's manage decisions.
 *
 * Why stronger than LLM for trading manage:
 *  - Learns from YOUR closed-trade rewards (pnl), not internet prose
 *  - Fixed latency, no hallucination, no API
 *  - Context = the same features the robot already sees (zone/story/pressure/…)
 *  - Updates every close (true online learning)
 *
 * Soft HardInv stays outside — learner only picks HOLD/TRAIL/CUT/BANK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDeskClientId } from './deskClientScope.js';
import type { ManageBrainAction, ManageBrainInput } from './manageBrain.js';
import {
  pressureFightsSide,
  storyFightsSide,
} from './marketContext.js';

export const LEARNER_ACTIONS: ManageBrainAction[] = [
  'HOLD',
  'TRAIL',
  'CUT',
  'BANK',
];

/** Stable feature order — do not reorder without resetting weights. */
export const LEARNER_FEATURE_NAMES = [
  'bias',
  'upl_over_soft',
  'mfe_over_soft',
  'mae_over_soft',
  'retention',
  'minute_continue',
  'minute_reverse',
  'minute_wait',
  'story_with',
  'story_against',
  'pressure_with',
  'pressure_against',
  'green_share',
  'expanding',
  'compressed',
  'moving',
  'feed_strong',
  'feed_divergent',
  'thesis_fail',
  'next_opposite',
  'session_e',
  'window_e',
  'soft_green',
  'giveback',
  'near_target',
  'held_norm',
] as const;

export type LearnerFeatures = number[];

type ActionWeights = Record<ManageBrainAction, number[]>;

type LearnerState = {
  version: 1;
  updates: number;
  weights: ActionWeights;
  updated_at: string;
};

const LR = 0.08;
const L2 = 0.002;
const TEMPERATURE = 0.85;
const EXPLORE_EPS = process.env.VITEST ? 0 : 0.06;
const MAX_W = 4;

function emptyWeights(): ActionWeights {
  const n = LEARNER_FEATURE_NAMES.length;
  const w = {} as ActionWeights;
  for (const a of LEARNER_ACTIONS) {
    w[a] = new Array(n).fill(0);
    // Small prior: HOLD likes continue; BANK likes reverse+green; CUT likes giveback
    w[a][0] = a === 'TRAIL' ? 0.15 : 0;
  }
  w.HOLD[LEARNER_FEATURE_NAMES.indexOf('minute_continue')] = 0.9;
  w.HOLD[LEARNER_FEATURE_NAMES.indexOf('story_with')] = 0.4;
  w.TRAIL[LEARNER_FEATURE_NAMES.indexOf('soft_green')] = 0.35;
  w.CUT[LEARNER_FEATURE_NAMES.indexOf('giveback')] = 0.8;
  w.CUT[LEARNER_FEATURE_NAMES.indexOf('story_against')] = 0.5;
  w.BANK[LEARNER_FEATURE_NAMES.indexOf('soft_green')] = 0.7;
  w.BANK[LEARNER_FEATURE_NAMES.indexOf('minute_reverse')] = 0.7;
  w.BANK[LEARNER_FEATURE_NAMES.indexOf('next_opposite')] = 0.5;
  return w;
}

function learnerPath(clientId: number): string {
  if (clientId > 0) {
    return path.join(process.cwd(), 'data', 'desk-learner', `client-${clientId}.json`);
  }
  return path.join(process.cwd(), 'data', 'desk-learner-session.json');
}

const cache = new Map<number, LearnerState>();

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function hydrate(clientId: number): LearnerState {
  const id = resolveDeskClientId(clientId);
  const hit = cache.get(id);
  if (hit) return hit;
  let st: LearnerState = {
    version: 1,
    updates: 0,
    weights: emptyWeights(),
    updated_at: new Date().toISOString(),
  };
  try {
    const file = learnerPath(id);
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LearnerState>;
      if (raw.weights && raw.version === 1) {
        const w = emptyWeights();
        for (const a of LEARNER_ACTIONS) {
          const src = raw.weights[a];
          if (Array.isArray(src) && src.length === LEARNER_FEATURE_NAMES.length) {
            w[a] = src.map((x) => clamp(Number(x) || 0, -MAX_W, MAX_W));
          }
        }
        st = {
          version: 1,
          updates: Number(raw.updates) || 0,
          weights: w,
          updated_at: String(raw.updated_at || st.updated_at),
        };
      }
    }
  } catch {
    /* fresh */
  }
  cache.set(id, st);
  return st;
}

function persist(clientId: number): void {
  const id = resolveDeskClientId(clientId);
  const st = cache.get(id);
  if (!st) return;
  try {
    const file = learnerPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function idx(name: (typeof LEARNER_FEATURE_NAMES)[number]): number {
  return LEARNER_FEATURE_NAMES.indexOf(name);
}

/** Build numeric features from live manage input. */
export function extractLearnerFeatures(input: ManageBrainInput): LearnerFeatures {
  const soft = Math.max(input.soft_sl, 1e-9);
  const mfe = Math.max(0, input.mfe);
  const mae = Math.max(0, input.mae);
  const upl = input.unrealized;
  const retention =
    input.peak_retention != null && Number.isFinite(input.peak_retention)
      ? input.peak_retention
      : mfe > 0
        ? Math.max(0, upl / mfe)
        : 1;
  const mkt = input.market;
  const storyWith =
    mkt != null &&
    (mkt.story?.allow === input.open_side || mkt.story?.allow === 'BOTH') &&
    !storyFightsSide(mkt.story?.allow, input.open_side);
  const storyAgainst = mkt != null && storyFightsSide(mkt.story?.allow, input.open_side);
  const pressureAgainst =
    mkt != null && pressureFightsSide(mkt.pressure.green_share, input.open_side);
  const pressureWith =
    mkt != null &&
    ((input.open_side === 'BUY' && mkt.pressure.green_share >= 0.58) ||
      (input.open_side === 'SELL' && mkt.pressure.green_share <= 0.42));

  const x = new Array(LEARNER_FEATURE_NAMES.length).fill(0);
  x[idx('bias')] = 1;
  x[idx('upl_over_soft')] = clamp(upl / soft, -2, 3);
  x[idx('mfe_over_soft')] = clamp(mfe / soft, 0, 4);
  x[idx('mae_over_soft')] = clamp(mae / soft, 0, 3);
  x[idx('retention')] = clamp(retention, 0, 1);
  x[idx('minute_continue')] = input.minute_policy === 'continue' ? 1 : 0;
  x[idx('minute_reverse')] = input.minute_policy === 'reverse' ? 1 : 0;
  x[idx('minute_wait')] = input.minute_policy === 'wait' ? 1 : 0;
  x[idx('story_with')] = storyWith ? 1 : 0;
  x[idx('story_against')] = storyAgainst ? 1 : 0;
  x[idx('pressure_with')] = pressureWith ? 1 : 0;
  x[idx('pressure_against')] = pressureAgainst ? 1 : 0;
  x[idx('green_share')] = clamp(mkt?.pressure.green_share ?? 0.5, 0, 1);
  x[idx('expanding')] = mkt?.velocity.expanding ? 1 : 0;
  x[idx('compressed')] = mkt?.velocity.compressed ? 1 : 0;
  x[idx('moving')] = mkt?.velocity.moving ? 1 : 0;
  x[idx('feed_strong')] = mkt?.feed?.agreement === 'STRONG' ? 1 : 0;
  x[idx('feed_divergent')] = mkt?.feed?.agreement === 'DIVERGENT' ? 1 : 0;
  x[idx('thesis_fail')] =
    input.live_regime &&
    input.entry_regime &&
    input.live_regime !== input.entry_regime &&
    input.live_regime !== 'UNKNOWN'
      ? 1
      : 0;
  x[idx('next_opposite')] =
    input.next_entry_side && input.next_entry_side !== input.open_side ? 1 : 0;
  x[idx('session_e')] = clamp(input.session_expectancy_pts, -3, 3);
  x[idx('window_e')] = clamp(input.last_window_expectancy ?? 0, -3, 3);
  x[idx('soft_green')] = upl >= soft * 0.95 && mfe >= soft ? 1 : 0;
  x[idx('giveback')] = mfe > soft && retention < 0.55 && upl > 0 ? 1 : 0;
  x[idx('near_target')] = upl >= input.target_dist * 0.85 ? 1 : 0;
  x[idx('held_norm')] = clamp(input.held_ms / 300_000, 0, 3);
  return x;
}

function dot(w: number[], x: number[]): number {
  let s = 0;
  const n = Math.min(w.length, x.length);
  for (let i = 0; i < n; i++) s += w[i]! * x[i]!;
  return s;
}

function softmaxScores(
  weights: ActionWeights,
  x: LearnerFeatures,
  temperature = TEMPERATURE
): Record<ManageBrainAction, number> {
  const logits: Record<ManageBrainAction, number> = {
    HOLD: 0,
    TRAIL: 0,
    CUT: 0,
    BANK: 0,
  };
  let maxL = -Infinity;
  for (const a of LEARNER_ACTIONS) {
    const L = dot(weights[a], x) / Math.max(temperature, 0.2);
    logits[a] = L;
    if (L > maxL) maxL = L;
  }
  let sum = 0;
  const exps: Record<ManageBrainAction, number> = {
    HOLD: 0,
    TRAIL: 0,
    CUT: 0,
    BANK: 0,
  };
  for (const a of LEARNER_ACTIONS) {
    const e = Math.exp(logits[a] - maxL);
    exps[a] = e;
    sum += e;
  }
  const out: Record<ManageBrainAction, number> = {
    HOLD: 0,
    TRAIL: 0,
    CUT: 0,
    BANK: 0,
  };
  for (const a of LEARNER_ACTIONS) {
    out[a] = sum > 0 ? exps[a]! / sum : 0.25;
  }
  return out;
}

export type LearnerDecision = {
  action: ManageBrainAction;
  confidence: number;
  probs: Record<ManageBrainAction, number>;
  features: LearnerFeatures;
  updates: number;
  explored: boolean;
  detail: string;
};

/**
 * Choose manage action from learned policy (+ light exploration).
 */
export function learnerChooseAction(
  input: ManageBrainInput,
  clientId?: number | null,
  rng: () => number = Math.random
): LearnerDecision {
  const id = resolveDeskClientId(clientId);
  const st = hydrate(id);
  const features = extractLearnerFeatures(input);
  const probs = softmaxScores(st.weights, features);
  let action: ManageBrainAction = 'TRAIL';
  let best = -1;
  for (const a of LEARNER_ACTIONS) {
    if (probs[a]! > best) {
      best = probs[a]!;
      action = a;
    }
  }
  let explored = false;
  if (rng() < EXPLORE_EPS) {
    action = LEARNER_ACTIONS[Math.floor(rng() * LEARNER_ACTIONS.length)]!;
    explored = true;
  }
  const confidence = probs[action] ?? 0.25;
  const top = LEARNER_ACTIONS.map((a) => `${a}:${(probs[a]! * 100).toFixed(0)}%`).join(' ');
  return {
    action,
    confidence,
    probs,
    features,
    updates: st.updates,
    explored,
    detail: `LEARNER ${action} · conf ${(confidence * 100).toFixed(0)}% · n=${st.updates} · ${top}${
      explored ? ' · explore' : ''
    }`,
  };
}

/**
 * Online update after a closed trade.
 * reward ≈ tanh(pnl / softScale) in [-1,1].
 */
export function learnerLearnFromClose(opts: {
  clientId?: number | null;
  features: LearnerFeatures | null | undefined;
  action: ManageBrainAction | string | null | undefined;
  pnl_pts: number;
  soft_scale?: number;
}): { updates: number; reward: number } | null {
  const action = String(opts.action || '').toUpperCase() as ManageBrainAction;
  if (!LEARNER_ACTIONS.includes(action)) return null;
  const x = opts.features;
  if (!x || x.length !== LEARNER_FEATURE_NAMES.length) return null;

  const id = resolveDeskClientId(opts.clientId);
  const st = hydrate(id);
  const scale = Math.max(opts.soft_scale || 2.2, 0.5);
  const reward = Math.tanh(opts.pnl_pts / scale);

  // Softmax policy-gradient style: reinforce chosen, slight demote others
  const probs = softmaxScores(st.weights, x);
  for (const a of LEARNER_ACTIONS) {
    const w = st.weights[a];
    const indicator = a === action ? 1 : 0;
    const adv = indicator - probs[a]!;
    for (let i = 0; i < w.length; i++) {
      const g = LR * reward * adv * x[i]! - L2 * w[i]!;
      w[i] = clamp(w[i]! + g, -MAX_W, MAX_W);
    }
  }
  st.updates += 1;
  st.updated_at = new Date().toISOString();
  persist(id);
  return { updates: st.updates, reward };
}

export function getLearnerStatus(clientId?: number | null): {
  client_id: number;
  updates: number;
  updated_at: string;
} {
  const id = resolveDeskClientId(clientId);
  const st = hydrate(id);
  return { client_id: id, updates: st.updates, updated_at: st.updated_at };
}

/** Test helper */
export function _resetLearnerForTests(clientId: number = 0): void {
  const id = resolveDeskClientId(clientId);
  cache.set(id, {
    version: 1,
    updates: 0,
    weights: emptyWeights(),
    updated_at: new Date().toISOString(),
  });
  try {
    const file = learnerPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
