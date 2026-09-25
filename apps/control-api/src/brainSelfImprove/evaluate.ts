/**
 * Evaluate candidate: vitest (allowlisted suites) + strategy replay vs baseline.
 * Entry-gate score covers genome knobs that structure-replay alone cannot see.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayStrategy, syntheticTrendBars } from '../services/strategyReplay.js';
import { readMultiTfStack, sideFromMultiTf } from '../services/multiTfRead.js';
import { reloadBrainGenome, getBrainGenome } from './brainGenome.js';

export type EvalScore = {
  expectancy_pts: number;
  trades: number;
  win_rate: number;
  sum_pnl_pts: number;
  soft_loss_share: number;
  /** Fraction of 1m-fight scenarios that correctly WAIT (higher = less Soft spam). */
  entry_wait_score: number;
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

/** Synthetic multi-TF stacks where 1m fights the higher-TF bias. */
function entryWaitScore(): number {
  reloadBrainGenome();
  const g = getBrainGenome();
  const cases: Array<{
    tf30: 'UP' | 'DOWN' | 'FLAT';
    tf15: 'UP' | 'DOWN' | 'FLAT';
    tf5: 'UP' | 'DOWN' | 'FLAT';
    tf1: 'UP' | 'DOWN' | 'FLAT';
    /** When wait_on_1m_fight is on, these should WAIT. */
    fightCase: boolean;
  }> = [
    { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN', tf1: 'UP', fightCase: true },
    { tf30: 'UP', tf15: 'UP', tf5: 'UP', tf1: 'DOWN', fightCase: true },
    { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN', tf1: 'DOWN', fightCase: false },
    { tf30: 'UP', tf15: 'UP', tf5: 'UP', tf1: 'UP', fightCase: false },
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
    if (c.fightCase) {
      // Correct defensive posture: WAIT while 1m fights (when genome says so)
      if (g.wait_on_1m_fight) {
        if (side === 'WAIT') ok += 1;
      } else if (side !== 'WAIT') {
        ok += 1;
      }
    } else if (side !== 'WAIT') {
      ok += 1;
    }
  }
  const triggerBonus = g.require_1m_trigger ? 0.1 : 0;
  return Math.min(1, ok / cases.length + triggerBonus);
}

function scoreFromReplay(): EvalScore {
  reloadBrainGenome();
  const barsA = syntheticTrendBars({ n: 320, step: 0.1 });
  const barsB = syntheticTrendBars({ n: 280, start: 4300, step: -0.12 });
  const a = replayStrategy(barsA, { spread_pts: 0.2, max_hold_bars: 70 });
  const b = replayStrategy(barsB, { spread_pts: 0.2, max_hold_bars: 70 });
  const trades = [...a.trades, ...b.trades];
  const sum = trades.reduce((s, t) => s + (t.pnl_pts || 0), 0);
  const wins = trades.filter((t) => (t.pnl_pts || 0) > 1e-9).length;
  const losses = trades.filter((t) => (t.pnl_pts || 0) < -1e-9).length;
  const softLosses = trades.filter((t) =>
    /HardInvalidation|HardInv/i.test(String(t.exit_reason || ''))
  ).length;
  const decided = wins + losses;
  return {
    expectancy_pts: trades.length ? sum / trades.length : 0,
    trades: trades.length,
    win_rate: decided > 0 ? wins / decided : 0,
    sum_pnl_pts: sum,
    soft_loss_share: trades.length ? softLosses / trades.length : 0,
    entry_wait_score: entryWaitScore(),
  };
}

/** Suites that guard trading-decision regressions. Never include brainSelfImprove.test.ts
 *  (that suite invokes the cycle → evaluate → vitest, which would recurse). */
const TEST_GLOBS = [
  'src/services/exitManage.test.ts',
  'src/services/traderMind.test.ts',
  'src/services/multiTfRead.test.ts',
  'src/services/manageBrain.test.ts',
  'src/services/strategyReplay.test.ts',
];

export function runBrainTests(): { ok: boolean; detail: string } {
  if (process.env.BRAIN_SKIP_NESTED_TESTS === '1') {
    return { ok: true, detail: 'vitest skipped (BRAIN_SKIP_NESTED_TESTS)' };
  }
  const cwd = controlApiRoot();
  const r = spawnSync(
    'npx',
    ['vitest', 'run', ...TEST_GLOBS],
    {
      cwd,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, FORCE_COLOR: '0', BRAIN_SKIP_NESTED_TESTS: '1' },
    }
  );
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const ok = r.status === 0;
  const tail = out.split('\n').slice(-20).join('\n');
  return { ok, detail: ok ? `vitest OK\n${tail}` : `vitest FAIL (code ${r.status})\n${tail}` };
}

export function evaluateCandidate(baseline: EvalScore): EvalReport {
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
  const notBroken = candidate.trades >= Math.max(0, baseline.trades - 3);
  const improved =
    notBroken &&
    (eGain > 0.02 ||
      (eGain >= -0.01 && (softImprove || wrImprove || entryImprove)));

  let reason: string;
  if (!notBroken) reason = `REJECTED — trade count collapsed ${baseline.trades}→${candidate.trades}`;
  else if (improved)
    reason = `ACCEPTED — E ${baseline.expectancy_pts.toFixed(3)}→${candidate.expectancy_pts.toFixed(3)} · WR ${(baseline.win_rate * 100).toFixed(0)}%→${(candidate.win_rate * 100).toFixed(0)}% · SoftShare ${(baseline.soft_loss_share * 100).toFixed(0)}%→${(candidate.soft_loss_share * 100).toFixed(0)}% · EntryWait ${(baseline.entry_wait_score * 100).toFixed(0)}%→${(candidate.entry_wait_score * 100).toFixed(0)}%`;
  else
    reason = `REJECTED — no improvement E ${baseline.expectancy_pts.toFixed(3)}→${candidate.expectancy_pts.toFixed(3)} · EntryWait ${(baseline.entry_wait_score * 100).toFixed(0)}%→${(candidate.entry_wait_score * 100).toFixed(0)}%`;

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
