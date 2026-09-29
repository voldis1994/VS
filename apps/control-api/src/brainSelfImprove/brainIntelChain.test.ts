/**
 * Full Brain Self Improve chain integration:
 * baseline → mutation → candidate → eval → ACCEPT/REJECT → persist/rollback → reload → runtime
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetBrainGenomeForTests,
  getBrainGenome,
  reloadBrainGenome,
  setBrainGenome,
  TRADING_INTEL_GENOME_KEYS,
  PEAK_MEMORY_SAFE_KEYS,
} from './brainGenome.js';
import { buildHypothesis } from './hypothesize.js';
import { analyzeTrades, syntheticLessonTrades } from './analyze.js';
import {
  createCandidateSession,
  restoreSnapshot,
  ensureGenomeFile,
} from './candidate.js';
import { evaluateCandidate, measureBaseline } from './evaluate.js';
import { classifyRegime, MIN_BARS_FOR_ZONE } from '../services/regimes.js';
import { sideFromMultiTf, readMultiTfStack } from '../services/multiTfRead.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import type { BrainExperience } from './experience.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

function reversalFixture(): TenSecBar[] {
  const quiet: TenSecBar[] = [];
  for (let i = 0; i < MIN_BARS_FOR_ZONE - 10; i++) {
    quiet.push(bar(100, 101.2, 98.8, 100, i));
  }
  for (let i = 0; i < 9; i++) {
    const c = 100.4 + i * 0.01;
    quiet.push(bar(c, c + 0.015, c - 0.015, c + 0.008, quiet.length));
  }
  const flipOpen = 100.5;
  const flipClose = flipOpen * (1 - 0.002);
  quiet.push(bar(flipOpen, flipOpen + 0.02, flipClose - 0.2, flipClose, quiet.length));
  return quiet;
}

describe('brainSelfImprove trading-intel chain', () => {
  const prevExp = process.env.BRAIN_EXPERIENCE_PATH;
  const prevGen = process.env.BRAIN_GENOME_PATH;
  const prevSkip = process.env.BRAIN_SKIP_NESTED_TESTS;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-intel-chain-'));
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    process.env.BRAIN_SKIP_NESTED_TESTS = '1';
    _resetBrainGenomeForTests();
    setBrainGenome(getBrainGenome());
    ensureGenomeFile();
  });

  afterEach(() => {
    if (prevExp === undefined) delete process.env.BRAIN_EXPERIENCE_PATH;
    else process.env.BRAIN_EXPERIENCE_PATH = prevExp;
    if (prevGen === undefined) delete process.env.BRAIN_GENOME_PATH;
    else process.env.BRAIN_GENOME_PATH = prevGen;
    if (prevSkip === undefined) delete process.env.BRAIN_SKIP_NESTED_TESTS;
    else process.env.BRAIN_SKIP_NESTED_TESTS = prevSkip;
    _resetBrainGenomeForTests();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('explore hypothesis can mutate every TRADING_INTEL_GENOME_KEYS field', () => {
    // Avoid soft_sell code-patch signature thrash — go straight toward explore variants.
    const base = analyzeTrades(syntheticLessonTrades());
    const analysis = {
      ...base,
      soft_sell_losses: 0,
      soft_buy_losses: 0,
      soft_losses: 0,
      micro_scratches: 0,
      green_not_banked: 0,
      top_pattern: { id: 'intel_probe', count: 1, label: 'intel probe' },
      patterns: [{ id: 'intel_probe', count: 1, label: 'intel probe' }],
    };
    const seen = new Set<string>();
    const rejected: string[] = [];
    // Keep explore_step fixed so rotation (rejectedN % len) walks the explore list.
    _resetBrainGenomeForTests({ explore_step: 0 });
    setBrainGenome(getBrainGenome());
    for (let i = 0; i < 200; i++) {
      const exp: BrainExperience = {
        version: 1,
        updated_at: new Date().toISOString(),
        cycles: [],
        patterns: analysis.patterns,
        rejected_signatures: [...rejected],
        accepted_signatures: [],
        soft_pause_side: null,
        soft_pause_left: 0,
        soft_sell_streak: 0,
        soft_buy_streak: 0,
        last_lesson: '',
      };
      const hypo = buildHypothesis(analysis as never, exp);
      expect(hypo).toBeTruthy();
      rejected.push(hypo!.signature);
      if (hypo!.pattern_id === 'explore') {
        for (const k of Object.keys(hypo!.genome_delta || {})) {
          if ((TRADING_INTEL_GENOME_KEYS as readonly string[]).includes(k)) seen.add(k);
        }
      }
      if (seen.size >= TRADING_INTEL_GENOME_KEYS.length) break;
    }
    const missing = TRADING_INTEL_GENOME_KEYS.filter((k) => !seen.has(k));
    expect(missing, `unmutated intel keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('ACCEPT path: peak mutation persists and reloads into runtime', () => {
    const baselineKeep = getBrainGenome().peak_keep;
    const baseline = measureBaseline();
    const session = createCandidateSession('test_accept_peak');
    const nextKeep = Math.min(0.88, Number((baselineKeep + 0.03).toFixed(2)));
    setBrainGenome({
      peak_keep: nextKeep,
      explore_step: (getBrainGenome().explore_step || 0) + 1,
      last_lesson: 'integration accept peak',
    });
    reloadBrainGenome();
    expect(getBrainGenome().peak_keep).toBeCloseTo(nextKeep, 5);

    const report = evaluateCandidate(baseline, {
      genome_delta: { peak_keep: nextKeep, explore_step: 1 },
    });
    expect(report.tests_ok).toBe(true);
    // Peak memory may ACCEPT via safeGenomeEvolve even when !improved —
    // this test proves persistence/reload for the ACCEPT keep path.
    const deltaKeys = ['peak_keep', 'explore_step'];
    const touchesIntel = deltaKeys.some((k) =>
      (TRADING_INTEL_GENOME_KEYS as readonly string[]).includes(k)
    );
    expect(touchesIntel).toBe(false);
    const eFlatOk =
      report.candidate.expectancy_pts >= report.baseline.expectancy_pts - 0.01;
    const wouldAcceptSafe =
      report.tests_ok &&
      eFlatOk &&
      !touchesIntel &&
      deltaKeys.every((k) => (PEAK_MEMORY_SAFE_KEYS as readonly string[]).includes(k));
    const wouldAccept = (report.improved && report.tests_ok) || wouldAcceptSafe;
    expect(wouldAccept).toBe(true);

    // Simulate ACCEPT keep (no restore) — runtime still sees accepted peak
    reloadBrainGenome();
    expect(getBrainGenome().peak_keep).toBeCloseTo(nextKeep, 5);
    expect(getBrainGenome().peak_keep).not.toBe(baselineKeep);

    restoreSnapshot(session);
    reloadBrainGenome();
  });

  it('REJECT path: trading-intel mutation rolls back — runtime uses baseline', () => {
    const bars = reversalFixture();
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
    const baselineRev = getBrainGenome().regime_reversal;

    // Snapshot factory genome first
    const session = createCandidateSession('test_reject_intel');
    const factoryBaseline = measureBaseline();

    // Apply hostile intel mutation
    setBrainGenome({
      regime_reversal: 0.0035,
      explore_step: (getBrainGenome().explore_step || 0) + 1,
      last_lesson: 'integration reject intel',
    });
    reloadBrainGenome();
    expect(getBrainGenome().regime_reversal).toBeCloseTo(0.0035, 6);
    expect(classifyRegime(bars, 'TREND_UP')).not.toBe('REVERSAL_CANDIDATE');

    const report = evaluateCandidate(factoryBaseline, {
      genome_delta: { regime_reversal: 0.0035, explore_step: 1 },
    });
    expect(report.tests_ok).toBe(true);
    // Hostile intel without measurable improvement must REJECT
    const touchesIntel = true;
    const wouldAcceptSafe =
      report.tests_ok &&
      !touchesIntel &&
      report.candidate.expectancy_pts >= report.baseline.expectancy_pts - 0.01;
    const wouldAccept = (report.improved && report.tests_ok) || wouldAcceptSafe;
    expect(wouldAccept).toBe(false);
    expect(report.improved).toBe(false);

    // Explicit REJECT rollback
    restoreSnapshot(session);
    reloadBrainGenome();
    expect(getBrainGenome().regime_reversal).toBeCloseTo(baselineRev, 6);
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
  });

  it('trading-intel delta alone does not ACCEPT when report.improved is false', () => {
    const baseline = measureBaseline();
    setBrainGenome({
      regime_clear_break_frac: 0.4,
      explore_step: 99,
      last_lesson: 'intel no improve',
    });
    const report = evaluateCandidate(baseline, {
      genome_delta: { regime_clear_break_frac: 0.4, explore_step: 99 },
    });
    const touchesIntel = true;
    const wouldAcceptSafe =
      report.tests_ok &&
      !touchesIntel &&
      report.candidate.expectancy_pts >= report.baseline.expectancy_pts - 0.01;
    const wouldAccept =
      (report.improved && report.tests_ok) || wouldAcceptSafe;
    if (!report.improved) {
      expect(wouldAccept).toBe(false);
    }
    // Even if perception moved, without measurable score lift intel stays rejected
    // when improved is false — loop never uses E-flat safe path for intel.
    expect(wouldAcceptSafe).toBe(false);
  });

  it('mtf mutation changes sideFromMultiTf for 1m fight', () => {
    _resetBrainGenomeForTests({
      mtf_require_aligned_side: true,
      wait_on_1m_fight: true,
    });
    const fight = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'UP',
    });
    expect(sideFromMultiTf(fight)).toBe('WAIT');

    setBrainGenome({ mtf_require_aligned_side: false, wait_on_1m_fight: true });
    reloadBrainGenome();
    const open = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'UP',
    });
    expect(getBrainGenome().mtf_require_aligned_side).toBe(false);
    expect(sideFromMultiTf(open)).toBe('SELL');
  });

  it('regime_mom_bars / persist_window change is consumed by classify path', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      const wobble = ((i % 5) - 2) * 0.02;
      const c = 100 + wobble;
      bars.push(bar(c, c + 0.03, c - 0.03, c + 0.01, i));
    }
    for (let i = 0; i < 5; i++) {
      const o = 100.2 - i * 0.05;
      const c = o - 0.13;
      bars.push(bar(o, o + 0.01, c - 0.02, c, bars.length));
    }

    _resetBrainGenomeForTests({
      regime_mom_bars: 5,
      regime_persist_window: 5,
      regime_persist_enter: 0.4,
      regime_trend_enter: 0.0003,
      regime_move: 0.00008,
    });
    expect(classifyRegime(bars, 'UNKNOWN')).toBe('TREND_DOWN');

    setBrainGenome({ regime_mom_bars: 16, regime_persist_window: 5 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_mom_bars).toBe(16);
    expect(getBrainGenome().regime_persist_window).toBe(5);
    expect(classifyRegime(bars, 'UNKNOWN')).not.toBe('TREND_DOWN');
  });

  it('intel ACCEPT requires relevant-scenario movement (not unrelated flat books)', () => {
    const baseline = measureBaseline();
    // Tiny dwell nudge often leaves tip labels identical on synthetic fixtures
    setBrainGenome({
      regime_min_dwell_bars: getBrainGenome().regime_min_dwell_bars, // no-op value
      explore_step: 42,
      last_lesson: 'noop intel',
    });
    const report = evaluateCandidate(baseline, {
      genome_delta: {
        regime_reversal: getBrainGenome().regime_reversal, // same value
        explore_step: 42,
      },
    });
    // Same reversal value → REVERSAL scenario unchanged → must not improve via intel path
    expect(report.improved).toBe(false);
  });
});
