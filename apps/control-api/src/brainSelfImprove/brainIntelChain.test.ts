/**
 * Full Brain Self Improve chain integration via real runBrainCycle():
 * baseline → mutation → candidate → eval → ACCEPT/REJECT → persist/rollback → reload → runtime
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _resetBrainGenomeForTests,
  getBrainGenome,
  reloadBrainGenome,
  setBrainGenome,
  TRADING_INTEL_GENOME_KEYS,
} from './brainGenome.js';
import { buildHypothesis } from './hypothesize.js';
import { analyzeTrades, syntheticLessonTrades } from './analyze.js';
import { ensureGenomeFile } from './candidate.js';
import { evaluateCandidate, measureBaseline, _evalInternals } from './evaluate.js';
import { runBrainCycle } from './loop.js';
import {
  loadExperience,
  saveExperience,
  type BrainExperience,
} from './experience.js';
import { classifyRegime, MIN_BARS_FOR_ZONE } from '../services/regimes.js';
import { sideFromMultiTf, readMultiTfStack } from '../services/multiTfRead.js';
import { minuteDirStrong } from '../services/structureEntry.js';
import { getActiveRegimeBands } from '../services/regimeBands.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

function emptyExp(overrides?: Partial<BrainExperience>): BrainExperience {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    cycles: [],
    patterns: [],
    rejected_signatures: [],
    accepted_signatures: [],
    soft_pause_side: null,
    soft_pause_left: 0,
    soft_sell_streak: 0,
    soft_buy_streak: 0,
    last_lesson: '',
    ...overrides,
  };
}

describe('brainSelfImprove trading-intel chain', () => {
  const prevExp = process.env.BRAIN_EXPERIENCE_PATH;
  const prevGen = process.env.BRAIN_GENOME_PATH;
  const prevSkip = process.env.BRAIN_SKIP_NESTED_TESTS;
  let tmp: string;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const patchTargets = [
    path.join(repoRoot, 'apps/control-api/src/services/flipFilter.ts'),
    path.join(repoRoot, 'apps/control-api/src/services/traderMind.ts'),
  ];
  const patchSnapshots = new Map<string, string>();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-intel-chain-'));
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    process.env.BRAIN_SKIP_NESTED_TESTS = '1';
    patchSnapshots.clear();
    for (const p of patchTargets) {
      try {
        patchSnapshots.set(p, fs.readFileSync(p, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    _resetBrainGenomeForTests();
    setBrainGenome(getBrainGenome());
    ensureGenomeFile();
    saveExperience(emptyExp());
  });

  afterEach(() => {
    if (prevExp === undefined) delete process.env.BRAIN_EXPERIENCE_PATH;
    else process.env.BRAIN_EXPERIENCE_PATH = prevExp;
    if (prevGen === undefined) delete process.env.BRAIN_GENOME_PATH;
    else process.env.BRAIN_GENOME_PATH = prevGen;
    if (prevSkip === undefined) delete process.env.BRAIN_SKIP_NESTED_TESTS;
    else process.env.BRAIN_SKIP_NESTED_TESTS = prevSkip;
    _resetBrainGenomeForTests();
    for (const [p, body] of patchSnapshots) {
      try {
        fs.writeFileSync(p, body, 'utf8');
      } catch {
        /* ignore */
      }
    }
    patchSnapshots.clear();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('explore hypothesis can mutate every TRADING_INTEL_GENOME_KEYS field', () => {
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
    _resetBrainGenomeForTests({ explore_step: 0 });
    setBrainGenome(getBrainGenome());
    for (let i = 0; i < 200; i++) {
      const exp = emptyExp({
        patterns: analysis.patterns,
        rejected_signatures: [...rejected],
      });
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

  it('runBrainCycle ACCEPT path: peak/memory persists and reloads into runtime', async () => {
    const before = getBrainGenome();
    const result = await runBrainCycle({
      trades: syntheticLessonTrades(),
      once: true,
    });
    expect(result.decision).toBe('ACCEPTED');
    reloadBrainGenome();
    const after = getBrainGenome();
    // Defensive Soft-memory ACCEPT bumps pause closes and/or lesson
    expect(
      after.soft_same_side_pause_closes !== before.soft_same_side_pause_closes ||
        after.require_1m_trigger === true ||
        after.last_lesson !== before.last_lesson
    ).toBe(true);
    const exp = loadExperience();
    expect(exp.cycles.some((c) => c.decision === 'ACCEPTED')).toBe(true);
    expect(exp.accepted_signatures.length).toBeGreaterThan(0);
  });

  it('runBrainCycle REJECT path: trading-intel rolls back — runtime uses baseline', async () => {
    const baselineRev = getBrainGenome().regime_reversal;
    const baselineMove = getBrainGenome().regime_move;
    const analysis = analyzeTrades(syntheticLessonTrades());
    // Reject Soft/peak variants until the next buildHypothesis would be intel explore —
    // leave that signature untried so runBrainCycle picks it.
    const rejected: string[] = [];
    for (let i = 0; i < 100; i++) {
      const hypo = buildHypothesis(
        analysis,
        emptyExp({ rejected_signatures: [...rejected], patterns: analysis.patterns })
      );
      expect(hypo).toBeTruthy();
      const intelKeys = Object.keys(hypo!.genome_delta || {}).filter((k) =>
        (TRADING_INTEL_GENOME_KEYS as readonly string[]).includes(k)
      );
      if (hypo!.pattern_id === 'explore' && intelKeys.length > 0) {
        break; // do not reject — cycle should try this intel hypo
      }
      rejected.push(hypo!.signature);
    }
    saveExperience(
      emptyExp({
        patterns: analysis.patterns,
        rejected_signatures: rejected,
      })
    );

    const result = await runBrainCycle({
      trades: syntheticLessonTrades(),
      once: true,
    });
    expect(result.decision).toBe('REJECTED');

    reloadBrainGenome();
    expect(getBrainGenome().regime_reversal).toBeCloseTo(baselineRev, 6);
    expect(getBrainGenome().regime_move).toBeCloseTo(baselineMove, 6);
    const exp = loadExperience();
    expect(exp.cycles.some((c) => c.decision === 'REJECTED')).toBe(true);
  });

  it('every TRADING_INTEL key has a discriminative evaluator probe', () => {
    const probes = _evalInternals.intelKeyProbes();
    const probeKeys = new Set(probes.map((p) => p.key));
    const mtfProbes = _evalInternals.scoreMtfIntelProbes();
    for (const k of Object.keys(mtfProbes)) probeKeys.add(k);
    const missing = TRADING_INTEL_GENOME_KEYS.filter((k) => !probeKeys.has(k));
    expect(missing, `keys without probes: ${missing.join(', ')}`).toEqual([]);

    // Factory probes should score; hostile reversal probe must drop
    const baseline = measureBaseline();
    expect(baseline.intel_probe_by_key.regime_reversal).toBeGreaterThan(0.5);

    setBrainGenome({ regime_reversal: 0.0035 });
    reloadBrainGenome();
    const hostile = measureBaseline();
    expect(hostile.intel_probe_by_key.regime_reversal).toBeLessThan(
      baseline.intel_probe_by_key.regime_reversal
    );
    // Mere/hostile change must not evaluate as improved
    const report = evaluateCandidate(baseline, {
      genome_delta: { regime_reversal: 0.0035 },
    });
    expect(report.improved).toBe(false);

    // Per-key MTF probes must miss under hostile genome (not shared entryWaitScore)
    _resetBrainGenomeForTests();
    expect(_evalInternals.scoreMtfIntelProbes().mtf_trek_flat_frac.hit).toBe(1);
    setBrainGenome({ mtf_trek_flat_frac: 0.001 });
    reloadBrainGenome();
    expect(_evalInternals.scoreMtfIntelProbes().mtf_trek_flat_frac.hit).toBe(0);
  });

  it('structureEntry + marketStory live path consume getActiveRegimeBands (not factory MOVE)', () => {
    const structureSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/control-api/src/services/structureEntry.ts'),
      'utf8'
    );
    const storySrc = fs.readFileSync(
      path.join(repoRoot, 'apps/control-api/src/services/marketStory.ts'),
      'utf8'
    );
    expect(structureSrc).toMatch(/getActiveRegimeBands/);
    expect(storySrc).toMatch(/getActiveRegimeBands/);
    expect(structureSrc).not.toMatch(
      /import\s*\{[^}]*\b(MOVE|ENTRY_DIP|ENTRY_RALLY)\b[^}]*\}\s*from\s*'\.\/regimeBands/
    );
    expect(storySrc).not.toMatch(
      /import\s*\{[^}]*\b(ENTRY_DIP|ENTRY_RALLY)\b[^}]*\}\s*from\s*'\.\/regimeBands/
    );

    _resetBrainGenomeForTests({ regime_move: 0.00008 });
    expect(getActiveRegimeBands().MOVE).toBeCloseTo(0.00008, 6);
    expect(getActiveRegimeBands().ENTRY_RALLY).toBeCloseTo(0.00008, 6);
    expect(getActiveRegimeBands().ENTRY_DIP).toBeCloseTo(-0.00008, 6);

    setBrainGenome({ regime_move: 0.00015 });
    reloadBrainGenome();
    expect(getActiveRegimeBands().MOVE).toBeCloseTo(0.00015, 6);
    expect(getActiveRegimeBands().ENTRY_RALLY).toBeCloseTo(0.00015, 6);
    // minuteDirStrong strong-threshold tracks live MOVE
    const m = {
      open_time_ms: 0,
      open: 100,
      high: 100.02,
      low: 99.98,
      close: 100.012, // 0.012%
      bars: 6,
    };
    expect(Math.abs(m.close - m.open) / m.open).toBeLessThan(getActiveRegimeBands().MOVE);
    // With raised MOVE, strong gate fails (body < MOVE); minuteDir still UP — prove threshold read
    _resetBrainGenomeForTests({ regime_move: 0.00008 });
    expect(Math.abs(m.close - m.open) / m.open).toBeGreaterThan(getActiveRegimeBands().MOVE);
    expect(minuteDirStrong(m)).toBe('UP');
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

  it('regime_mom_bars change is consumed by classify → live decision path', () => {
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
    expect(classifyRegime(bars, 'UNKNOWN')).not.toBe('TREND_DOWN');
  });
});
