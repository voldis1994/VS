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
import { readMultiTfStack, sideFromMultiTf } from '../services/multiTfRead.js';
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
  return [
    {
      id: 'TREND_UP',
      expected: 'TREND_UP',
      previous: 'UNKNOWN',
      bars: syntheticTrendBars({ n: 200, step: 0.12 }),
    },
    {
      id: 'TREND_DOWN',
      expected: 'TREND_DOWN',
      previous: 'UNKNOWN',
      bars: syntheticTrendBars({ n: 200, start: 4300, step: -0.12 }),
    },
    {
      id: 'RANGE',
      expected: ['RANGE', 'COMPRESSION', 'TRANSITION'],
      previous: 'RANGE',
      bars: syntheticRangeBars({ n: 160 }),
    },
    {
      id: 'COMPRESSION',
      expected: ['COMPRESSION', 'RANGE'],
      previous: 'RANGE',
      bars: syntheticCompressionExpansionBars({ n: 140, expand_at: 999 }),
    },
    {
      id: 'EXPANSION',
      expected: ['EXPANSION', 'BREAKOUT_UP', 'BREAKOUT_DOWN', 'TREND_UP', 'TREND_DOWN'],
      previous: 'COMPRESSION',
      bars: syntheticCompressionExpansionBars({ n: 160, expand_at: 120 }),
    },
    {
      id: 'COMPRESSION_TO_EXPANSION',
      expected: ['EXPANSION', 'BREAKOUT_UP', 'BREAKOUT_DOWN', 'TREND_UP'],
      previous: 'COMPRESSION',
      bars: syntheticCompressionExpansionBars({ n: 180, expand_at: 130 }),
    },
    {
      id: 'BREAKOUT_UP',
      expected: ['BREAKOUT_UP', 'TREND_UP', 'EXPANSION'],
      previous: 'RANGE',
      bars: syntheticBreakoutBars({ direction: 'UP', n: 160 }),
    },
    {
      id: 'BREAKOUT_DOWN',
      expected: ['BREAKOUT_DOWN', 'TREND_DOWN', 'EXPANSION'],
      previous: 'RANGE',
      bars: syntheticBreakoutBars({ direction: 'DOWN', n: 160 }),
    },
    {
      id: 'REVERSAL',
      expected: ['REVERSAL_CANDIDATE', 'PULLBACK_UPTREND', 'TREND_DOWN', 'RANGE'],
      previous: 'TREND_UP',
      bars: syntheticReversalBars({ n: 150 }),
    },
    {
      id: 'FAILED_BREAKOUT',
      expected: ['FAILED_BREAKOUT_UP', 'FAILED_BREAKOUT_DOWN', 'RANGE', 'REVERSAL_CANDIDATE'],
      previous: 'BREAKOUT_UP',
      bars: syntheticFailedBreakoutBars({ n: 150 }),
    },
    {
      id: 'TRANSITION',
      expected: ['TRANSITION', 'RANGE', 'UNKNOWN', 'TREND_UP', 'TREND_DOWN'],
      previous: 'TRANSITION',
      bars: syntheticRangeBars({ n: 100, wobble: 0.03 }),
    },
  ];
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

function regimePerception(): { score: number; fingerprint: string; labels: Record<string, string> } {
  reloadBrainGenome();
  const labels: Record<string, string> = {};
  let hits = 0;
  const scenarios = regimeScenarios();
  for (const s of scenarios) {
    const got = classifyTip(s.bars, s.previous);
    labels[s.id] = got;
    const ok = Array.isArray(s.expected) ? s.expected.includes(got) : got === s.expected;
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
  'mtf_htf_veto',
  'entry_story_conf_min',
  'entry_chop_conf_max',
]);

function relevantScenarioIds(deltaKeys: string[]): string[] {
  const ids = new Set<string>();
  for (const k of deltaKeys) {
    const mapped = INTEL_KEY_SCENARIOS[k];
    if (mapped) for (const id of mapped) ids.add(id);
  }
  return [...ids];
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
  if (touchesMtf && entryMoved) {
    return { moved: true, detail: `mtf/entry_wait ${baseline.entry_wait_score}→${candidate.entry_wait_score}` };
  }
  if (relevant.length === 0) {
    // Unknown intel key — fall back to global fingerprint
    const moved = candidate.perception_fingerprint !== baseline.perception_fingerprint || entryMoved;
    return { moved, detail: moved ? 'global perception' : 'no perception change' };
  }
  if (changed.length) {
    return { moved: true, detail: `scenarios ${changed.join(',')}` };
  }
  // Regime-only intel must move its own scenarios — unchanged elsewhere is not enough.
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

  // Measurable improvement required — flat E alone is not enough.
  let improved =
    notBroken &&
    (eGain > 0.02 ||
      (eGain >= -0.01 && (softImprove || wrImprove || entryImprove || regimeImprove)));

  // Trading-intel must move perception on scenarios the mutation owns.
  if (improved && touchesTradingIntel && !relevant.moved) {
    improved = false;
  }
  // Trading-intel also needs a real score lift (not barely-not-worse E).
  if (improved && touchesTradingIntel && eGain <= 0 && !entryImprove && !regimeImprove) {
    improved = false;
  }

  let reason: string;
  if (!notBroken)
    reason = `REJECTED — trade count collapsed ${baseline.trades}→${candidate.trades}`;
  else if (touchesTradingIntel && !relevant.moved)
    reason = `REJECTED — trading-intel ${relevant.detail}`;
  else if (improved)
    reason = `ACCEPTED — E ${baseline.expectancy_pts.toFixed(3)}→${candidate.expectancy_pts.toFixed(3)} · WR ${(baseline.win_rate * 100).toFixed(0)}%→${(candidate.win_rate * 100).toFixed(0)}% · SoftShare ${(baseline.soft_loss_share * 100).toFixed(0)}%→${(candidate.soft_loss_share * 100).toFixed(0)}% · EntryWait ${(baseline.entry_wait_score * 100).toFixed(0)}%→${(candidate.entry_wait_score * 100).toFixed(0)}% · Regime ${(baseline.regime_score * 100).toFixed(0)}%→${(candidate.regime_score * 100).toFixed(0)}%`;
  else
    reason = `REJECTED — no improvement E ${baseline.expectancy_pts.toFixed(3)}→${candidate.expectancy_pts.toFixed(3)} · EntryWait ${(baseline.entry_wait_score * 100).toFixed(0)}%→${(candidate.entry_wait_score * 100).toFixed(0)}% · Regime ${(baseline.regime_score * 100).toFixed(0)}%→${(candidate.regime_score * 100).toFixed(0)}%`;

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
};
