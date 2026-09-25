/**
 * EntryLearner — real TypeScript brain: chooses BUY / SELL / WAIT from live
 * market features (30m story + regime + **live 1m impulse**) and learns from
 * closed-trade pnl.
 *
 * v2: 1m tape is first-class. Selling into a clear 1m rally (or buying a 1m
 * selloff) is incoherent with the picture → WAIT / flip preference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDeskClientId } from './deskClientScope.js';
import type { MarketStory } from './marketStory.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';
import { normalizeRegime } from './regimes.js';

export const ENTRY_LEARNER_ACTIONS = ['BUY', 'SELL', 'WAIT'] as const;
export type EntryLearnerAction = (typeof ENTRY_LEARNER_ACTIONS)[number];

/** Stable feature order — bump ENTRY_LEARNER_VERSION if changed. */
export const ENTRY_FEATURE_NAMES = [
  'story_allow_buy',
  'story_allow_sell',
  'story_none',
  'chapter_selloff',
  'chapter_rally',
  'chapter_bounce_sell',
  'chapter_dip_rally',
  'chapter_chop',
  'chapter_break_up',
  'chapter_break_down',
  'regime_up',
  'regime_down',
  'regime_range',
  'regime_failed_up',
  'regime_failed_down',
  'regime_reversal',
  'green_share',
  'red_dom',
  'zone_lo',
  'zone_hi',
  'zone_mid',
  'bar_buy',
  'bar_sell',
  'story_conf',
  'last_buy_loss',
  'last_sell_loss',
  'moving',
  /** Live 1m tape — what a human sees on Capital 1m */
  'm1_up',
  'm1_down',
  'm1_strong',
  'bias_up',
  'bias_down',
] as const;

export const ENTRY_LEARNER_VERSION = 2;

export type EntryFeatures = number[];

type ActionWeights = Record<EntryLearnerAction, number[]>;

type EntryLearnerState = {
  version: number;
  updates: number;
  weights: ActionWeights;
  updated_at: string;
};

const LR = 0.1;
const L2 = 0.002;
const TEMPERATURE = 0.9;
const EXPLORE_EPS = process.env.VITEST ? 0 : 0.05;
const MAX_W = 4;

const cache = new Map<number, EntryLearnerState>();

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function learnerPath(clientId: number): string {
  return path.join(process.cwd(), 'data', 'desk-entry-learner', `client-${clientId}.json`);
}

function emptyWeights(): ActionWeights {
  const n = ENTRY_FEATURE_NAMES.length;
  const w = {} as ActionWeights;
  for (const a of ENTRY_LEARNER_ACTIONS) {
    w[a] = new Array(n).fill(0);
  }
  const ix = (name: (typeof ENTRY_FEATURE_NAMES)[number]) =>
    ENTRY_FEATURE_NAMES.indexOf(name);

  w.SELL[ix('story_allow_sell')] = 1.0;
  w.SELL[ix('chapter_selloff')] = 0.9;
  w.SELL[ix('chapter_bounce_sell')] = 0.8;
  w.SELL[ix('regime_down')] = 2.2;
  w.SELL[ix('regime_failed_up')] = 2.0;
  w.SELL[ix('red_dom')] = 0.6;
  w.SELL[ix('bar_sell')] = 0.4;
  w.SELL[ix('last_buy_loss')] = 0.7;
  w.SELL[ix('chapter_break_down')] = 0.9;
  w.SELL[ix('m1_down')] = 2.4;
  w.SELL[ix('bias_down')] = 1.6;
  w.SELL[ix('m1_strong')] = 0.3;
  w.SELL[ix('m1_up')] = -3.2;
  w.SELL[ix('bias_up')] = -2.0;

  w.BUY[ix('story_allow_buy')] = 1.0;
  w.BUY[ix('chapter_rally')] = 0.9;
  w.BUY[ix('chapter_dip_rally')] = 0.8;
  w.BUY[ix('regime_up')] = 2.2;
  w.BUY[ix('regime_failed_down')] = 2.0;
  w.BUY[ix('green_share')] = 0.6;
  w.BUY[ix('bar_buy')] = 0.4;
  w.BUY[ix('last_sell_loss')] = 0.7;
  w.BUY[ix('chapter_break_up')] = 0.9;
  w.BUY[ix('m1_up')] = 2.4;
  w.BUY[ix('bias_up')] = 1.6;
  w.BUY[ix('m1_strong')] = 0.3;
  w.BUY[ix('m1_down')] = -3.2;
  w.BUY[ix('bias_down')] = -2.0;

  w.WAIT[ix('story_none')] = 1.2;
  w.WAIT[ix('chapter_chop')] = 1.3;
  w.WAIT[ix('regime_down')] = -1.2;
  w.WAIT[ix('regime_up')] = -1.2;
  w.WAIT[ix('regime_failed_up')] = -1.0;
  w.WAIT[ix('regime_failed_down')] = -1.0;
  w.WAIT[ix('m1_up')] = 0.35;
  w.WAIT[ix('m1_down')] = 0.35;
  w.BUY[ix('chapter_bounce_sell')] = -1.8;
  w.SELL[ix('chapter_dip_rally')] = -1.8;
  w.WAIT[ix('chapter_bounce_sell')] = 0.55;
  w.WAIT[ix('chapter_dip_rally')] = 0.55;

  return w;
}

function hydrate(clientId: number): EntryLearnerState {
  const id = resolveDeskClientId(clientId);
  const hit = cache.get(id);
  if (hit) return hit;
  let st: EntryLearnerState = {
    version: ENTRY_LEARNER_VERSION,
    updates: 0,
    weights: emptyWeights(),
    updated_at: new Date().toISOString(),
  };
  try {
    const file = learnerPath(id);
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EntryLearnerState>;
      if (raw.weights && Number(raw.version) === ENTRY_LEARNER_VERSION) {
        const w = emptyWeights();
        let ok = true;
        for (const a of ENTRY_LEARNER_ACTIONS) {
          const src = raw.weights[a];
          if (!Array.isArray(src) || src.length !== ENTRY_FEATURE_NAMES.length) {
            ok = false;
            break;
          }
          w[a] = src.map((x) => clamp(Number(x) || 0, -MAX_W, MAX_W));
        }
        if (ok) {
          st = {
            version: ENTRY_LEARNER_VERSION,
            updates: Number(raw.updates) || 0,
            weights: w,
            updated_at: String(raw.updated_at || st.updated_at),
          };
        }
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

export type EntryFeatureInput = {
  regime?: string | null;
  story: Pick<
    MarketStory,
    'chapter' | 'allow' | 'confidence' | 'red_1m' | 'green_1m' | 'zone_pos'
  >;
  bar?: TenSecBar | null;
  zone_pos?: number | null;
  last_closed_side?: 'BUY' | 'SELL' | null;
  last_close_was_loss?: boolean;
  moving?: boolean;
  /** Live 1m direction from the robot's 10s book */
  m1_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  /** |1m body| is meaningful (not flat noise) */
  m1_strong?: boolean;
  /** Multi-1m trek bias */
  bias?: 'UP' | 'DOWN' | 'FLAT' | null;
};

export function extractEntryFeatures(input: EntryFeatureInput): EntryFeatures {
  const chapter = String(input.story.chapter || '').toUpperCase();
  const allow = String(input.story.allow || 'NONE').toUpperCase();
  const regime = normalizeRegime(input.regime);
  const g = input.story.green_1m ?? 0;
  const r = input.story.red_1m ?? 0;
  const tot = Math.max(g + r, 1);
  const greenShare = g / tot;
  const pos =
    input.zone_pos != null && Number.isFinite(input.zone_pos)
      ? input.zone_pos
      : input.story.zone_pos;
  const body = input.bar ? bodyPct(input.bar) : 0;
  const conf = Number.isFinite(input.story.confidence) ? input.story.confidence : 0;
  const md = input.m1_dir || 'FLAT';
  const bias = input.bias || 'FLAT';
  const m1Strong = input.m1_strong ? 1 : 0;

  const feat: Record<(typeof ENTRY_FEATURE_NAMES)[number], number> = {
    story_allow_buy: allow === 'BUY' || allow === 'BOTH' ? 1 : 0,
    story_allow_sell: allow === 'SELL' || allow === 'BOTH' ? 1 : 0,
    story_none: allow === 'NONE' ? 1 : 0,
    chapter_selloff: chapter === 'SELLOFF' || chapter === 'EXHAUST_LO' ? 1 : 0,
    chapter_rally: chapter === 'RALLY' || chapter === 'EXHAUST_HI' ? 1 : 0,
    chapter_bounce_sell: chapter === 'BOUNCE_IN_SELL' ? 1 : 0,
    chapter_dip_rally: chapter === 'DIP_IN_RALLY' ? 1 : 0,
    chapter_chop: chapter === 'RANGE_CHOP' ? 1 : 0,
    chapter_break_up: chapter === 'BREAK_UP' ? 1 : 0,
    chapter_break_down: chapter === 'BREAK_DOWN' ? 1 : 0,
    regime_up:
      regime === 'TREND_UP' ||
      regime === 'BREAKOUT_UP' ||
      regime === 'PULLBACK_UPTREND'
        ? 1
        : 0,
    regime_down:
      regime === 'TREND_DOWN' ||
      regime === 'BREAKOUT_DOWN' ||
      regime === 'PULLBACK_DOWNTREND'
        ? 1
        : 0,
    regime_range:
      regime === 'RANGE' || regime === 'COMPRESSION' || regime === 'TRANSITION'
        ? 1
        : 0,
    regime_failed_up: regime === 'FAILED_BREAKOUT_UP' ? 1 : 0,
    regime_failed_down: regime === 'FAILED_BREAKOUT_DOWN' ? 1 : 0,
    regime_reversal: regime === 'REVERSAL_CANDIDATE' ? 1 : 0,
    green_share: greenShare,
    red_dom: r > g + 1 ? 1 : 0,
    zone_lo: pos != null && pos <= 0.35 ? 1 : 0,
    zone_hi: pos != null && pos >= 0.65 ? 1 : 0,
    zone_mid: pos != null && pos > 0.35 && pos < 0.65 ? 1 : 0,
    bar_buy: body > 1e-8 ? 1 : 0,
    bar_sell: body < -1e-8 ? 1 : 0,
    story_conf: clamp(conf, 0, 1),
    last_buy_loss:
      input.last_close_was_loss && input.last_closed_side === 'BUY' ? 1 : 0,
    last_sell_loss:
      input.last_close_was_loss && input.last_closed_side === 'SELL' ? 1 : 0,
    moving: input.moving ? 1 : 0,
    m1_up: md === 'UP' ? 1 : 0,
    m1_down: md === 'DOWN' ? 1 : 0,
    m1_strong: m1Strong,
    bias_up: bias === 'UP' ? 1 : 0,
    bias_down: bias === 'DOWN' ? 1 : 0,
  };

  return ENTRY_FEATURE_NAMES.map((name) => feat[name]);
}

function softmaxScores(
  weights: ActionWeights,
  features: EntryFeatures
): Record<EntryLearnerAction, number> {
  const logits: Record<EntryLearnerAction, number> = {
    BUY: 0,
    SELL: 0,
    WAIT: 0,
  };
  for (const a of ENTRY_LEARNER_ACTIONS) {
    let s = 0;
    const w = weights[a];
    for (let i = 0; i < features.length; i++) s += w[i]! * features[i]!;
    logits[a] = s / TEMPERATURE;
  }
  const maxL = Math.max(logits.BUY, logits.SELL, logits.WAIT);
  const exps: Record<EntryLearnerAction, number> = { BUY: 0, SELL: 0, WAIT: 0 };
  let sum = 0;
  for (const a of ENTRY_LEARNER_ACTIONS) {
    const e = Math.exp(logits[a] - maxL);
    exps[a] = e;
    sum += e;
  }
  const out: Record<EntryLearnerAction, number> = { BUY: 0, SELL: 0, WAIT: 0 };
  for (const a of ENTRY_LEARNER_ACTIONS) {
    out[a] = sum > 0 ? exps[a]! / sum : 1 / 3;
  }
  return out;
}

export type EntryLearnerDecision = {
  action: EntryLearnerAction;
  confidence: number;
  probs: Record<EntryLearnerAction, number>;
  features: EntryFeatures;
  updates: number;
  explored: boolean;
  detail: string;
};

/**
 * Softmax pick — no 1m knife list. Side coherency lives in the entry mind
 * (multi-TF stack). Learner only reinforces; structureEntry refuses opposite.
 */
export function entryLearnerChoose(
  input: EntryFeatureInput,
  clientId?: number | null,
  rng: () => number = Math.random
): EntryLearnerDecision {
  const id = resolveDeskClientId(clientId);
  const st = hydrate(id);
  const features = extractEntryFeatures(input);
  const probs = softmaxScores(st.weights, features);
  let action: EntryLearnerAction = 'WAIT';
  let best = -1;
  for (const a of ENTRY_LEARNER_ACTIONS) {
    if (probs[a]! > best) {
      best = probs[a]!;
      action = a;
    }
  }
  let explored = false;
  if (rng() < EXPLORE_EPS) {
    action = ENTRY_LEARNER_ACTIONS[Math.floor(rng() * ENTRY_LEARNER_ACTIONS.length)]!;
    explored = true;
  }

  const confidence = probs[action] ?? 0.33;
  const top = ENTRY_LEARNER_ACTIONS.map(
    (a) => `${a}:${(probs[a]! * 100).toFixed(0)}%`
  ).join(' ');
  const detail = `PRĀTS ENTRY ${action} · conf ${(confidence * 100).toFixed(0)}% · n=${st.updates} · ${top}${
    explored ? ' · explore' : ''
  }`;

  return {
    action,
    confidence,
    probs,
    features,
    updates: st.updates,
    explored,
    detail,
  };
}

export function entryLearnerLearnFromClose(opts: {
  clientId?: number | null;
  features: EntryFeatures | null | undefined;
  action: 'BUY' | 'SELL' | string | null | undefined;
  pnl_pts: number;
  soft_scale?: number;
}): { updates: number; reward: number } | null {
  const side = String(opts.action || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return null;
  const action = side as EntryLearnerAction;
  const x = opts.features;
  if (!x || x.length !== ENTRY_FEATURE_NAMES.length) return null;

  const id = resolveDeskClientId(opts.clientId);
  const st = hydrate(id);
  const scale = Math.max(opts.soft_scale || 2.2, 0.5);
  const reward = Math.tanh(opts.pnl_pts / scale);

  const probs = softmaxScores(st.weights, x);
  for (const a of ENTRY_LEARNER_ACTIONS) {
    const w = st.weights[a];
    const indicator = a === action ? 1 : 0;
    const adv = indicator - probs[a]!;
    for (let i = 0; i < w.length; i++) {
      const g = LR * reward * adv * x[i]! - L2 * w[i]!;
      w[i] = clamp(w[i]! + g, -MAX_W, MAX_W);
    }
  }
  if (reward < -0.15) {
    const wWait = st.weights.WAIT;
    for (let i = 0; i < wWait.length; i++) {
      wWait[i] = clamp(wWait[i]! + LR * (-reward) * 0.35 * x[i]!, -MAX_W, MAX_W);
    }
  }

  st.updates += 1;
  st.updated_at = new Date().toISOString();
  persist(id);
  return { updates: st.updates, reward };
}

export function getEntryLearnerStatus(clientId?: number | null): {
  client_id: number;
  updates: number;
  updated_at: string;
} {
  const id = resolveDeskClientId(clientId);
  const st = hydrate(id);
  return { client_id: id, updates: st.updates, updated_at: st.updated_at };
}

export function _resetEntryLearnerForTests(clientId: number = 0): void {
  const id = resolveDeskClientId(clientId);
  cache.set(id, {
    version: ENTRY_LEARNER_VERSION,
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
