/**
 * Evaluate candidate: vitest (factory genome regression) + multi-scenario replay
 * vs baseline using the live candidate genome.
 *
 * Trading-intelligence mutations must move perception on relevant scenarios and
 * show measurable score improvement — not free ACCEPT on flat expectancy.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  replayStrategy,
  syntheticTrendBars,
  syntheticRangeBars,
  syntheticCompressionExpansionBars,
  syntheticBreakoutBars,
  syntheticReversalBars,
  syntheticFailedBreakoutBars,
} from '../services/strategyReplay.js';
import { readMultiTfStack, sideFromMultiTf, capitalTfTrekDir } from '../services/multiTfRead.js';
import { classifyRegime, stabilizeRegime, type RegimeName } from '../services/regimes.js';
import { thinkEntryLikeTrader } from '../services/traderMind.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import {
  defaultBrainGenome,
  reloadBrainGenome,
  getBrainGenome,
  TRADING_INTEL_GENOME_KEYS,
} from './brainGenome.js';

export type EvalScore = {
  expectancy_pts: number;
  trades: number;
  win_rate: number;
  sum_pnl_pts: number;
  soft_loss_share: number;
  /** Fraction of multi-TF fight scenarios that take the genome-consistent posture. */
  entry_wait_score: number;
  /** Regime-scenario hit rate (factory-expected labels under active genome). */
  regime_score: number;
  /** Fingerprint of classify labels across regime fixtures — detects no-op mutations. */
  perception_fingerprint: string;
  /** Per-scenario classify tip labels (for mutation-relevant ACCEPT gates). */
  regime_labels: Record<string, string>;
  /**
   * Per TRADING_INTEL key: hit rate on that key's discriminative probe(s).
   * Used to tell measurable improvement from mere behaviour change.
   */
  intel_probe_by_key: Record<string, number>;
};

export type EvalReport = {
  tests_ok: boolean;
  test_detail: string;
  baseline: EvalScore;
  candidate: EvalScore;
  improved: boolean;
  reason: string;
};

function controlApiRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

/** Synthetic multi-TF stacks covering fight / align / higher-fight / HTF cases. */
function entryWaitScore(): number {
  reloadBrainGenome();
  const g = getBrainGenome();
  const cases: Array<{
    tf30: 'UP' | 'DOWN' | 'FLAT';
    tf15: 'UP' | 'DOWN' | 'FLAT';
    tf5: 'UP' | 'DOWN' | 'FLAT';
    tf1: 'UP' | 'DOWN' | 'FLAT';
    kind: 'fight' | 'aligned' | 'higher_fight';
  }> = [
    { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN', tf1: 'UP', kind: 'fight' },
    { tf30: 'UP', tf15: 'UP', tf5: 'UP', tf1: 'DOWN', kind: 'fight' },
    { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN', tf1: 'DOWN', kind: 'aligned' },
    { tf30: 'UP', tf15: 'UP', tf5: 'UP', tf1: 'UP', kind: 'aligned' },
    { tf30: 'UP', tf15: 'DOWN', tf5: 'FLAT', tf1: 'FLAT', kind: 'higher_fight' },
    { tf30: 'DOWN', tf15: 'UP', tf5: 'DOWN', tf1: 'DOWN', kind: 'higher_fight' },
  ];

  let ok = 0;
  for (const c of cases) {
    const stack = readMultiTfStack({
      tf30: c.tf30,
      tf15: c.tf15,
      tf5: c.tf5,
      tf1: c.tf1,
    });
    const side = sideFromMultiTf(stack);
    if (c.kind === 'fight') {
      if (g.wait_on_1m_fight) {
        if (side === 'WAIT') ok += 1;
      } else if (g.mtf_require_aligned_side) {
        if (side === 'WAIT') ok += 1;
      } else if (side !== 'WAIT') {
        ok += 1;
      }
    } else if (c.kind === 'aligned') {
      if (side !== 'WAIT') ok += 1;
    } else if (c.kind === 'higher_fight') {
      if (g.mtf_block_higher_fight) {
        if (side === 'WAIT') ok += 1;
      } else if (side !== 'WAIT' || !g.mtf_require_aligned_side) {
        ok += 1;
      }
    }
  }

  // HTF veto consistency: story SELL under UP 30/15 must WAIT when veto on
  const vetoThought = thinkEntryLikeTrader({
    regime: 'RANGE',
    chapter: 'SELLOFF',
    allow: 'SELL',
    story_conf: 0.8,
    red_1m: 14,
    green_1m: 6,
    zone_pos: 0.55,
    bar_body_sign: -1,
    m1_dir: 'FLAT',
    bias: 'UP',
    tf5_dir: 'FLAT',
    tf15_dir: 'UP',
    tf30_dir: 'UP',
  });
  if (g.mtf_htf_veto) {
    if (vetoThought.choice !== 'SELL') ok += 1;
  } else {
    ok += 0.5;
  }

  const triggerBonus = g.require_1m_trigger ? 0.05 : 0;
  const denom = cases.length + 1;
  return Math.min(1, ok / denom + triggerBonus);
}

type RegimeScenario = {
  id: string;
  expected: RegimeName | RegimeName[];
  previous: RegimeName;
  bars: TenSecBar[];
};

function regimeScenarios(): RegimeScenario[] {
  // Price ~100 so body/range fractions clear factory MOVE/TREND bands
  // (Gold-scale synthetics with tiny absolute steps classify as RANGE/EXPANSION).
  return [
    {
      id: 'TREND_UP',
      expected: ['TREND_UP', 'EXPANSION', 'PULLBACK_UPTREND', 'REVERSAL_CANDIDATE'],
      previous: 'TREND_UP',
      bars: syntheticTrendBars({ n: 200, start: 100, step: 0.05 }),
    },
    {
      id: 'TREND_DOWN',
      expected: ['TREND_DOWN', 'EXPANSION', 'PULLBACK_DOWNTREND', 'REVERSAL_CANDIDATE'],
      previous: 'TREND_DOWN',
      bars: syntheticTrendBars({ n: 200, start: 100, step: -0.05 }),
    },
    {
      id: 'RANGE',
      expected: ['RANGE', 'COMPRESSION', 'TRANSITION'],
      previous: 'RANGE',
      bars: syntheticRangeBars({ n: 160, start: 100 }),
    },
    {
      id: 'COMPRESSION',
      expected: ['COMPRESSION', 'RANGE'],
      previous: 'RANGE',
      bars: syntheticCompressionExpansionBars({ n: 140, start: 100, expand_at: 999 }),
    },
    {
      id: 'EXPANSION',
      expected: ['EXPANSION', 'BREAKOUT_UP', 'BREAKOUT_DOWN', 'TREND_UP', 'TREND_DOWN'],
      previous: 'COMPRESSION',
      bars: syntheticCompressionExpansionBars({ n: 160, start: 100, expand_at: 120 }),
    },
    {
      id: 'COMPRESSION_TO_EXPANSION',
      expected: ['EXPANSION', 'BREAKOUT_UP', 'BREAKOUT_DOWN', 'TREND_UP', 'TREND_DOWN'],
      previous: 'COMPRESSION',
      bars: syntheticCompressionExpansionBars({ n: 180, start: 100, expand_at: 130 }),
    },
    {
      id: 'BREAKOUT_UP',
      expected: ['BREAKOUT_UP', 'TREND_UP', 'EXPANSION'],
      previous: 'RANGE',
      bars: syntheticBreakoutBars({ direction: 'UP', n: 160, start: 100 }),
    },
    {
      id: 'BREAKOUT_DOWN',
      expected: ['BREAKOUT_DOWN', 'TREND_DOWN', 'EXPANSION'],
      previous: 'RANGE',
      bars: syntheticBreakoutBars({ direction: 'DOWN', n: 160, start: 100 }),
    },
    {
      id: 'REVERSAL',
      expected: ['REVERSAL_CANDIDATE', 'PULLBACK_UPTREND', 'TREND_DOWN', 'RANGE', 'BREAKOUT_DOWN'],
      previous: 'TREND_UP',
      bars: syntheticReversalBars({ n: 150, start: 100 }),
    },
    {
      id: 'FAILED_BREAKOUT',
      expected: ['FAILED_BREAKOUT_UP', 'FAILED_BREAKOUT_DOWN', 'RANGE', 'REVERSAL_CANDIDATE'],
      previous: 'BREAKOUT_UP',
      bars: syntheticFailedBreakoutBars({ n: 150, start: 100 }),
    },
    {
      id: 'TRANSITION',
      expected: ['TRANSITION', 'RANGE', 'UNKNOWN', 'TREND_UP', 'TREND_DOWN', 'COMPRESSION'],
      previous: 'TRANSITION',
      bars: syntheticRangeBars({ n: 100, start: 100, wobble: 0.03 }),
    },
  ];
}

function tipBar(open: number, high: number, low: number, close: number, i: number): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

/** Handcrafted books that factory genome hits and a hostile key mutation can miss. */
function reversalProbeBars(): TenSecBar[] {
  const quiet: TenSecBar[] = [];
  for (let i = 0; i < 90 - 10; i++) {
    quiet.push(tipBar(100, 101.2, 98.8, 100, i));
  }
  for (let i = 0; i < 9; i++) {
    const c = 100.4 + i * 0.01;
    quiet.push(tipBar(c, c + 0.015, c - 0.015, c + 0.008, quiet.length));
  }
  const flipOpen = 100.5;
  const flipClose = flipOpen * (1 - 0.002);
  quiet.push(tipBar(flipOpen, flipOpen + 0.02, flipClose - 0.2, flipClose, quiet.length));
  return quiet;
}

function failedBreakProbeBars(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  for (let i = 0; i < 90; i++) {
    bars.push(tipBar(100, 100.4, 99.6, 100, i));
  }
  const o = 100.05;
  const c = o - 0.012;
  bars.push(tipBar(o, o + 0.005, c - 0.005, c, bars.length));
  return bars;
}

function momDilutionBars(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  for (let i = 0; i < 90; i++) {
    const wobble = ((i % 5) - 2) * 0.02;
    const c = 100 + wobble;
    bars.push(tipBar(c, c + 0.03, c - 0.03, c + 0.01, i));
  }
  for (let i = 0; i < 5; i++) {
    const o = 100.2 - i * 0.05;
    const c = o - 0.13;
    bars.push(tipBar(o, o + 0.01, c - 0.02, c, bars.length));
  }
  return bars;
}

function persistStayBars(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  for (let i = 0; i < 90; i++) {
    bars.push(tipBar(100, 100.8, 99.2, 100, i));
  }
  const seq = [-1, -1, -1, -1, 1, -1];
  let px = 100;
  for (const s of seq) {
    const o = px;
    const c = o + s * 0.04;
    bars.push(tipBar(o, Math.max(o, c) + 0.01, Math.min(o, c) - 0.01, c, bars.length));
    px = c;
  }
  return bars;
}

function compressNearMidBars(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  for (let i = 0; i < 90 - 12; i++) {
    bars.push(tipBar(100, 100.6, 99.4, 100, i));
  }
  for (let i = 0; i < 12; i++) {
    bars.push(tipBar(100.0, 100.003, 99.997, 100.0, bars.length));
  }
  bars.push(tipBar(100.0, 100.002, 99.998, 100.0, bars.length));
  return bars;
}

function clearBreakBars(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  for (let i = 0; i < 90; i++) {
    bars.push(tipBar(100, 100.3, 99.7, 100, i));
  }
  const pierce = 100.3 + 0.6 * 0.15;
  bars.push(tipBar(100.1, pierce + 0.05, 100.0, pierce, bars.length));
  return bars;
}

/**
 * Discriminative probes per intelligence key — factory genome should hit;
 * hostile mutation of that key should miss. Enables improve-vs-mere-change.
 */
function intelKeyProbes(): Array<{
  key: string;
  id: string;
  previous: RegimeName;
  expected: RegimeName | RegimeName[];
  bars: TenSecBar[];
}> {
  return [
    {
      key: 'regime_move',
      id: 'p_move',
      previous: 'BREAKOUT_UP',
      expected: 'FAILED_BREAKOUT_UP',
      bars: failedBreakProbeBars(),
    },
    {
      key: 'regime_trend_stay',
      id: 'p_stay',
      previous: 'TREND_DOWN',
      expected: 'TREND_DOWN',
      bars: persistStayBars(),
    },
    {
      key: 'regime_trend_enter',
      id: 'p_enter',
      previous: 'UNKNOWN',
      expected: 'TREND_DOWN',
      bars: momDilutionBars(),
    },
    {
      key: 'regime_pullback',
      id: 'p_pull',
      previous: 'TREND_UP',
      expected: ['TREND_UP', 'PULLBACK_UPTREND', 'REVERSAL_CANDIDATE'],
      bars: syntheticTrendBars({ n: 200, start: 100, step: 0.05 }),
    },
    {
      key: 'regime_reversal',
      id: 'p_rev',
      previous: 'TREND_UP',
      expected: 'REVERSAL_CANDIDATE',
      bars: reversalProbeBars(),
    },
    {
      key: 'regime_move_range',
      id: 'p_mrange',
      previous: 'RANGE',
      expected: ['RANGE', 'COMPRESSION'],
      bars: syntheticRangeBars({ n: 160, start: 100 }),
    },
    {
      key: 'regime_compress_abs',
      id: 'p_cabs',
      previous: 'RANGE',
      expected: 'COMPRESSION',
      bars: compressNearMidBars(),
    },
    {
      key: 'regime_expand_abs',
      id: 'p_eabs',
      previous: 'COMPRESSION',
      expected: ['EXPANSION', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT_UP'],
      bars: syntheticCompressionExpansionBars({ n: 160, start: 100, expand_at: 120 }),
    },
    {
      key: 'regime_compress_avg_mult',
      id: 'p_cmult',
      previous: 'RANGE',
      expected: 'COMPRESSION',
      bars: compressNearMidBars(),
    },
    {
      key: 'regime_expand_avg_mult',
      id: 'p_emult',
      previous: 'COMPRESSION',
      expected: ['EXPANSION', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT_UP'],
      bars: syntheticCompressionExpansionBars({ n: 160, start: 100, expand_at: 120 }),
    },
    {
      key: 'regime_near_zone_mid',
      id: 'p_near',
      previous: 'RANGE',
      expected: 'COMPRESSION',
      bars: compressNearMidBars(),
    },
    {
      key: 'regime_clear_break_frac',
      id: 'p_break',
      previous: 'RANGE',
      expected: ['BREAKOUT_UP', 'TREND_UP', 'RANGE', 'EXPANSION'],
      bars: clearBreakBars(),
    },
    {
      key: 'regime_persist_enter',
      id: 'p_penter',
      previous: 'UNKNOWN',
      expected: 'TREND_DOWN',
      bars: momDilutionBars(),
    },
    {
      key: 'regime_persist_stay',
      id: 'p_pstay',
      previous: 'TREND_DOWN',
      expected: 'TREND_DOWN',
      bars: persistStayBars(),
    },
    {
      key: 'regime_persist_pullback',
      id: 'p_ppull',
      previous: 'TREND_UP',
      expected: ['TREND_UP', 'PULLBACK_UPTREND', 'REVERSAL_CANDIDATE', 'RANGE'],
      bars: syntheticTrendBars({ n: 200, start: 100, step: 0.05 }),
    },
    {
      key: 'regime_min_dwell_bars',
      id: 'p_dwell',
      previous: 'RANGE',
      expected: ['RANGE', 'COMPRESSION', 'TRANSITION', 'UNKNOWN'],
      bars: syntheticRangeBars({ n: 160, start: 100 }),
    },
    {
      key: 'regime_confirm_bars',
      id: 'p_confirm',
      previous: 'TRANSITION',
      expected: ['TRANSITION', 'RANGE', 'UNKNOWN', 'COMPRESSION'],
      bars: syntheticRangeBars({ n: 100, start: 100, wobble: 0.03 }),
    },
    {
      key: 'regime_mom_bars',
      id: 'p_mom',
      previous: 'UNKNOWN',
      expected: 'TREND_DOWN',
      bars: momDilutionBars(),
    },
    {
      key: 'regime_persist_window',
      id: 'p_pwin',
      previous: 'UNKNOWN',
      expected: 'TREND_DOWN',
      bars: momDilutionBars(),
    },
  ];
}

function scoreIntelProbes(): Record<string, number> {
  reloadBrainGenome();
  const probes = intelKeyProbes();
  const sums: Record<string, { hit: number; n: number }> = {};
  for (const p of probes) {
    // Direct classify (not stabilize) — probes measure perception thresholds
    const got = classifyRegime(p.bars, p.previous);
    const ok = labelHit(p.expected, got);
    const slot = sums[p.key] || { hit: 0, n: 0 };
    slot.n += 1;
    if (ok) slot.hit += 1;
    sums[p.key] = slot;
  }
  // Per-key MTF / entry probes — must move when THAT key changes (not shared entryWaitScore)
  Object.assign(sums, scoreMtfIntelProbes());
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(sums)) {
    out[k] = v.n ? v.hit / v.n : 0;
  }
  return out;
}

/**
 * Discriminative probes for each MTF / entry-mind genome key.
 * Always scored against factory-expected outcome so flipping that key drops the hit.
 */
function scoreMtfIntelProbes(): Record<string, { hit: number; n: number }> {
  reloadBrainGenome();
  const out: Record<string, { hit: number; n: number }> = {};

  // mtf_trek_flat_frac — Gold-scale trek ~2pts: factory 0.0004 (≈1.06 flat) → UP;
  // loose 0.001 (≈2.65 flat) → FLAT
  {
    const candles = [
      { open: 2650.0, high: 2650.6, low: 2649.8, close: 2650.4 },
      { open: 2650.4, high: 2651.0, low: 2650.2, close: 2650.8 },
      { open: 2650.8, high: 2651.4, low: 2650.5, close: 2651.1 },
      { open: 2651.1, high: 2651.6, low: 2650.9, close: 2651.4 },
      { open: 2651.4, high: 2651.8, low: 2651.2, close: 2651.5 }, // tip dropped
    ];
    const dir = capitalTfTrekDir(candles, 4);
    out.mtf_trek_flat_frac = { hit: dir === 'UP' ? 1 : 0, n: 1 };
  }

  // mtf_block_higher_fight — factory true: 30/15 fight → FLAT bias + WAIT
  {
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'DOWN',
      tf5: 'FLAT',
      tf1: 'FLAT',
    });
    const hit = stack.bias === 'FLAT' && sideFromMultiTf(stack) === 'WAIT';
    out.mtf_block_higher_fight = { hit: hit ? 1 : 0, n: 1 };
  }

  // mtf_require_aligned_side — factory true: 1m fight → WAIT
  {
    const stack = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'UP',
    });
    out.mtf_require_aligned_side = {
      hit: sideFromMultiTf(stack) === 'WAIT' ? 1 : 0,
      n: 1,
    };
  }

  // entry_story_conf_min — factory 0.55: conf 0.5 must not take story SELL.
  // Avoid SELLOFF auto-SELL; tf5 UP vs m1 DOWN keeps stack bias FLAT (no only-1m
  // bias) so we reach the story-conf branch; m1 DOWN satisfies require_1m_trigger.
  {
    const thought = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'BREAK_DOWN',
      allow: 'SELL',
      story_conf: 0.5,
      red_1m: 14,
      green_1m: 6,
      zone_pos: 0.5,
      bar_body_sign: -1,
      m1_dir: 'DOWN',
      bias: 'FLAT',
      tf5_dir: 'UP',
      tf15_dir: 'FLAT',
      tf30_dir: 'FLAT',
    });
    out.entry_story_conf_min = { hit: thought.choice !== 'SELL' ? 1 : 0, n: 1 };
  }

  return out;
}

function classifyTip(bars: TenSecBar[], previous: RegimeName): RegimeName {
  const book = {
    current: previous,
    previous: 'UNKNOWN' as RegimeName,
    bars_in_current: 20,
    pending: null as RegimeName | null,
    pending_count: 0,
    since: new Date(0).toISOString(),
  };
  // Walk last stretch so stabilize can settle
  const start = Math.max(0, bars.length - 24);
  let label: RegimeName = previous;
  for (let i = start; i < bars.length; i++) {
    const hist = bars.slice(0, i + 1);
    const raw = classifyRegime(hist, book.current);
    label = stabilizeRegime(book, raw, new Date(i * 10_000).toISOString());
  }
  return label;
}

function labelHit(expected: RegimeName | RegimeName[], got: RegimeName): boolean {
  return Array.isArray(expected) ? expected.includes(got) : got === expected;
}

function regimePerception(): { score: number; fingerprint: string; labels: Record<string, string> } {
  reloadBrainGenome();
  const labels: Record<string, string> = {};
  let hits = 0;
  const scenarios = regimeScenarios();
  for (const s of scenarios) {
    const got = classifyTip(s.bars, s.previous);
    labels[s.id] = got;
    const ok = labelHit(s.expected, got);
    if (ok) hits += 1;
  }
  const fingerprint = createHash('sha1')
    .update(JSON.stringify(labels))
    .digest('hex')
    .slice(0, 16);
  return { score: hits / scenarios.length, fingerprint, labels };
}

function scoreFromReplay(): EvalScore {
  reloadBrainGenome();
  const books = [
    syntheticTrendBars({ n: 280, step: 0.1 }),
    syntheticTrendBars({ n: 260, start: 4300, step: -0.12 }),
    syntheticRangeBars({ n: 220 }),
    syntheticCompressionExpansionBars({ n: 240, expand_at: 160 }),
    syntheticBreakoutBars({ direction: 'UP', n: 220 }),
    syntheticBreakoutBars({ direction: 'DOWN', n: 220 }),
    syntheticReversalBars({ n: 220 }),
    syntheticFailedBreakoutBars({ n: 220 }),
  ];
  const trades = books.flatMap((bars) =>
    replayStrategy(bars, { spread_pts: 0.2, max_hold_bars: 70 }).trades
  );
  const sum = trades.reduce((s, t) => s + (t.pnl_pts || 0), 0);
  const wins = trades.filter((t) => (t.pnl_pts || 0) > 1e-9).length;
  const losses = trades.filter((t) => (t.pnl_pts || 0) < -1e-9).length;
  const softLosses = trades.filter((t) =>
    /HardInvalidation|HardInv/i.test(String(t.exit_reason || ''))
  ).length;
  const decided = wins + losses;
  const perception = regimePerception();
  return {
    expectancy_pts: trades.length ? sum / trades.length : 0,
    trades: trades.length,
    win_rate: decided > 0 ? wins / decided : 0,
    sum_pnl_pts: sum,
    soft_loss_share: trades.length ? softLosses / trades.length : 0,
    entry_wait_score: entryWaitScore(),
    regime_score: perception.score,
    perception_fingerprint: perception.fingerprint,
    regime_labels: perception.labels,
    intel_probe_by_key: scoreIntelProbes(),
  };
}

/** Suites that guard trading-decision regressions against factory genome. */
const TEST_GLOBS = [
  'src/services/exitManage.test.ts',
  'src/services/traderMind.test.ts',
  'src/services/multiTfRead.test.ts',
  'src/services/manageBrain.test.ts',
  'src/services/strategyReplay.test.ts',
  'src/services/flipFilter.test.ts',
];

function resolveVitestCli(cwd: string): string | null {
  const candidates = [
    path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(cwd, 'node_modules', 'vitest', 'dist', 'cli.js'),
    path.join(cwd, 'node_modules', 'vitest', 'vitest.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function runBrainTests(): { ok: boolean; detail: string } {
  if (process.env.BRAIN_SKIP_NESTED_TESTS === '1') {
    return { ok: true, detail: 'vitest skipped (BRAIN_SKIP_NESTED_TESTS)' };
  }
  const cwd = controlApiRoot();
  const vitestCli = resolveVitestCli(cwd);
  if (!vitestCli) {
    return {
      ok: false,
      detail: `vitest FAIL — nav node_modules/vitest (cwd=${cwd}). Palaid npm install apps\\control-api`,
    };
  }
  // Factory regression only — candidate scoring uses live genome separately.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-vitest-genome-'));
  const factoryGenomePath = path.join(tmpDir, 'genome.json');
  fs.writeFileSync(
    factoryGenomePath,
    JSON.stringify(
      { ...defaultBrainGenome(), updated_at: new Date().toISOString() },
      null,
      2
    ) + '\n',
    'utf8'
  );
  const r = spawnSync(process.execPath, [vitestCli, 'run', ...TEST_GLOBS], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      BRAIN_SKIP_NESTED_TESTS: '1',
      BRAIN_GENOME_PATH: factoryGenomePath,
    },
  });
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const spawnErr = r.error ? `spawn: ${r.error.message}` : '';
  const out = `${r.stdout || ''}\n${r.stderr || ''}\n${spawnErr}`.trim();
  const ok = r.status === 0;
  const tail = out.split('\n').slice(-24).join('\n');
  return {
    ok,
    detail: ok
      ? `vitest OK (factory genome)\n${tail}`
      : `vitest FAIL (code ${r.status}${r.signal ? ` signal=${r.signal}` : ''})\n${tail}`,
  };
}

export type EvaluateOpts = {
  /** Candidate genome_delta — used to require perception movement for trading-intel. */
  genome_delta?: Record<string, unknown> | null;
};

/** Which regime scenarios a trading-intel key is expected to affect. */
const INTEL_KEY_SCENARIOS: Record<string, readonly string[]> = {
  regime_move: ['TREND_UP', 'TREND_DOWN', 'FAILED_BREAKOUT', 'TRANSITION', 'RANGE'],
  regime_trend_stay: ['TREND_UP', 'TREND_DOWN'],
  regime_trend_enter: ['TREND_UP', 'TREND_DOWN', 'BREAKOUT_UP', 'BREAKOUT_DOWN'],
  regime_pullback: ['REVERSAL', 'TREND_UP', 'TREND_DOWN'],
  regime_reversal: ['REVERSAL'],
  regime_move_range: ['RANGE', 'COMPRESSION', 'TRANSITION'],
  regime_compress_abs: ['COMPRESSION', 'RANGE', 'COMPRESSION_TO_EXPANSION'],
  regime_expand_abs: ['EXPANSION', 'COMPRESSION_TO_EXPANSION', 'BREAKOUT_UP', 'BREAKOUT_DOWN'],
  regime_compress_avg_mult: ['COMPRESSION', 'RANGE'],
  regime_expand_avg_mult: ['EXPANSION', 'COMPRESSION_TO_EXPANSION'],
  regime_near_zone_mid: ['COMPRESSION', 'RANGE'],
  regime_clear_break_frac: ['BREAKOUT_UP', 'BREAKOUT_DOWN', 'FAILED_BREAKOUT'],
  regime_persist_enter: ['TREND_UP', 'TREND_DOWN'],
  regime_persist_stay: ['TREND_UP', 'TREND_DOWN'],
  regime_persist_pullback: ['REVERSAL', 'TREND_UP', 'TREND_DOWN'],
  regime_min_dwell_bars: [
    'TREND_UP',
    'TREND_DOWN',
    'RANGE',
    'TRANSITION',
    'COMPRESSION',
    'EXPANSION',
  ],
  regime_confirm_bars: [
    'TREND_UP',
    'TREND_DOWN',
    'RANGE',
    'TRANSITION',
    'COMPRESSION',
    'EXPANSION',
  ],
  regime_mom_bars: ['TREND_UP', 'TREND_DOWN', 'REVERSAL', 'COMPRESSION', 'EXPANSION'],
  regime_persist_window: ['TREND_UP', 'TREND_DOWN', 'REVERSAL'],
};

const MTF_INTEL_KEYS = new Set([
  'mtf_trek_flat_frac',
  'mtf_block_higher_fight',
  'mtf_require_aligned_side',
  'entry_story_conf_min',
]);

function relevantScenarioIds(deltaKeys: string[]): string[] {
  const ids = new Set<string>();
  for (const k of deltaKeys) {
    const mapped = INTEL_KEY_SCENARIOS[k];
    if (mapped) for (const id of mapped) ids.add(id);
  }
  return [...ids];
}

function meanProbeForKeys(
  probes: Record<string, number>,
  keys: string[]
): number | null {
  const vals = keys.map((k) => probes[k]).filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function relevantPerceptionMoved(
  baseline: EvalScore,
  candidate: EvalScore,
  deltaKeys: string[]
): { moved: boolean; detail: string } {
  const touchesMtf = deltaKeys.some((k) => MTF_INTEL_KEYS.has(k));
  const entryMoved =
    Math.abs(candidate.entry_wait_score - baseline.entry_wait_score) > 1e-9;
  const relevant = relevantScenarioIds(deltaKeys);
  const changed: string[] = [];
  for (const id of relevant) {
    if ((baseline.regime_labels?.[id] || '') !== (candidate.regime_labels?.[id] || '')) {
      changed.push(id);
    }
  }
  const intelKeys = deltaKeys.filter((k) =>
    (TRADING_INTEL_GENOME_KEYS as readonly string[]).includes(k)
  );
  const baseProbe = meanProbeForKeys(baseline.intel_probe_by_key || {}, intelKeys);
  const candProbe = meanProbeForKeys(candidate.intel_probe_by_key || {}, intelKeys);
  const probeMoved =
    baseProbe != null && candProbe != null && Math.abs(candProbe - baseProbe) > 1e-9;

  if (touchesMtf && entryMoved) {
    return { moved: true, detail: `mtf/entry_wait ${baseline.entry_wait_score}→${candidate.entry_wait_score}` };
  }
  if (relevant.length === 0) {
    const moved =
      candidate.perception_fingerprint !== baseline.perception_fingerprint ||
      entryMoved ||
      Boolean(probeMoved);
    return { moved, detail: moved ? 'global perception' : 'no perception change' };
  }
  if (changed.length || probeMoved) {
    return {
      moved: true,
      detail: changed.length
        ? `scenarios ${changed.join(',')}`
        : `probe ${baseProbe?.toFixed(2)}→${candProbe?.toFixed(2)}`,
    };
  }
  return {
    moved: false,
    detail: `relevant scenarios unchanged (${relevant.join(',')})`,
  };
}

export function evaluateCandidate(baseline: EvalScore, opts?: EvaluateOpts): EvalReport {
  const tests = runBrainTests();
  if (!tests.ok) {
    return {
      tests_ok: false,
      test_detail: tests.detail,
      baseline,
      candidate: baseline,
      improved: false,
      reason: 'TESTS FAILED — reject',
    };
  }
  const candidate = scoreFromReplay();
  const eGain = candidate.expectancy_pts - baseline.expectancy_pts;
  const softImprove = candidate.soft_loss_share < baseline.soft_loss_share - 0.02;
  const wrImprove = candidate.win_rate > baseline.win_rate + 0.02;
  const entryImprove = candidate.entry_wait_score > baseline.entry_wait_score + 0.04;
  const regimeImprove = candidate.regime_score > baseline.regime_score + 0.04;
  const notBroken = candidate.trades >= Math.max(0, baseline.trades - 3);

  const deltaKeys = Object.keys(opts?.genome_delta || {}).filter((k) => k !== 'last_lesson');
  const touchesTradingIntel = deltaKeys.some((k) =>
    (TRADING_INTEL_GENOME_KEYS as readonly string[]).includes(k)
  );
  const relevant = relevantPerceptionMoved(baseline, candidate, deltaKeys);
  const intelKeys = deltaKeys.filter((k) =>
    (TRADING_INTEL_GENOME_KEYS as readonly string[]).includes(k)
  );
  const baseProbe = meanProbeForKeys(baseline.intel_probe_by_key || {}, intelKeys);
  const candProbe = meanProbeForKeys(candidate.intel_probe_by_key || {}, intelKeys);
  const probeImprove =
    baseProbe != null && candProbe != null && candProbe > baseProbe + 0.04;
  const probeNotWorse =
    baseProbe == null || candProbe == null || candProbe >= baseProbe - 1e-9;

  // Peak/memory: measurable improvement — flat E alone is not enough.
  let improved =
    notBroken &&
    (eGain > 0.02 ||
      (eGain >= -0.01 && (softImprove || wrImprove || entryImprove || regimeImprove)));

  if (touchesTradingIntel) {
    // Intel: must move owned scenarios/probes, must not degrade key probes,
    // and must show real lift (probe/entry/E) — mere behaviour change ≠ ACCEPT.
    improved =
      notBroken &&
      relevant.moved &&
      probeNotWorse &&
      (probeImprove || entryImprove || eGain > 0.02 || (regimeImprove && probeImprove));
  }

  let reason: string;
  if (!notBroken)
    reason = `REJECTED — trade count collapsed ${baseline.trades}→${candidate.trades}`;
  else if (touchesTradingIntel && !relevant.moved)
    reason = `REJECTED — trading-intel ${relevant.detail}`;
  else if (touchesTradingIntel && !probeNotWorse)
    reason = `REJECTED — intel probe degraded ${baseProbe?.toFixed(2)}→${candProbe?.toFixed(2)} (mere change, not improvement)`;
  else if (improved)
    reason = `ACCEPTED — E ${baseline.expectancy_pts.toFixed(3)}→${candidate.expectancy_pts.toFixed(3)} · WR ${(baseline.win_rate * 100).toFixed(0)}%→${(candidate.win_rate * 100).toFixed(0)}% · SoftShare ${(baseline.soft_loss_share * 100).toFixed(0)}%→${(candidate.soft_loss_share * 100).toFixed(0)}% · EntryWait ${(baseline.entry_wait_score * 100).toFixed(0)}%→${(candidate.entry_wait_score * 100).toFixed(0)}% · Regime ${(baseline.regime_score * 100).toFixed(0)}%→${(candidate.regime_score * 100).toFixed(0)}% · Probe ${baseProbe != null ? baseProbe.toFixed(2) : 'n/a'}→${candProbe != null ? candProbe.toFixed(2) : 'n/a'}`;
  else
    reason = `REJECTED — no improvement E ${baseline.expectancy_pts.toFixed(3)}→${candidate.expectancy_pts.toFixed(3)} · EntryWait ${(baseline.entry_wait_score * 100).toFixed(0)}%→${(candidate.entry_wait_score * 100).toFixed(0)}% · Regime ${(baseline.regime_score * 100).toFixed(0)}%→${(candidate.regime_score * 100).toFixed(0)}% · Probe ${baseProbe != null ? baseProbe.toFixed(2) : 'n/a'}→${candProbe != null ? candProbe.toFixed(2) : 'n/a'}`;

  return {
    tests_ok: true,
    test_detail: tests.detail,
    baseline,
    candidate,
    improved,
    reason,
  };
}

export function measureBaseline(): EvalScore {
  return scoreFromReplay();
}

/** Expose for integration tests */
export const _evalInternals = {
  entryWaitScore,
  regimePerception,
  scoreFromReplay,
  regimeScenarios,
  intelKeyProbes,
  scoreIntelProbes,
  scoreMtfIntelProbes,
};
