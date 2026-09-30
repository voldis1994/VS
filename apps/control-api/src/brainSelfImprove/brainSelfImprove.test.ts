import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPatchesAllowed,
  isPathAllowed,
  isPatchContentAllowed,
} from './guards.js';
import { analyzeTrades, syntheticLessonTrades } from './analyze.js';
import { buildHypothesis } from './hypothesize.js';
import {
  _resetBrainGenomeForTests,
  getBrainGenome,
  sanitizeGenome,
  setBrainGenome,
} from './brainGenome.js';
import {
  hypothesisSignature,
  loadExperience,
  saveExperience,
  wasAlreadyTried,
  type BrainExperience,
} from './experience.js';
import { runBrainCycle } from './loop.js';

describe('brainSelfImprove guards', () => {
  it('allows all trading decision paths and blocks lot/broker/security/core', () => {
    expect(isPathAllowed('apps/control-api/src/services/exitManage.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/regimes.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/regimeBands.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/entryFromRegime.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/entryWatch.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/robotDesk.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/flipFilter.ts').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/tradeOpenPolicy.ts').ok).toBe(true);
    expect(isPathAllowed('data/brain-self-improve/genome.json').ok).toBe(true);
    expect(isPathAllowed('apps/control-api/src/services/capitalCom.ts').ok).toBe(false);
    expect(isPathAllowed('apps/control-api/src/security/encryption.ts').ok).toBe(false);
    expect(isPathAllowed('apps/control-api/src/brainSelfImprove/guards.ts').ok).toBe(false);
    expect(isPathAllowed('apps/control-api/src/services/intentFanout.ts').ok).toBe(false);
    expect(isPatchContentAllowed('a', 'lot_size: 0.5').ok).toBe(false);
    expect(() =>
      assertPatchesAllowed([
        {
          path: 'apps/control-api/src/services/capitalCom.ts',
          find: 'x',
          replace: 'y',
          note: 'no',
        },
      ])
    ).toThrow(/GUARD/);
  });
});

describe('brainSelfImprove analyze + hypothesize', () => {
  const prevGen = process.env.BRAIN_GENOME_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hyp-'));
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    _resetBrainGenomeForTests({
      wait_on_1m_fight: true,
      require_1m_trigger: true,
      peak_keep: 0.75,
      peak_arm_soft_mult: 1,
    });
    fs.writeFileSync(
      process.env.BRAIN_GENOME_PATH,
      JSON.stringify(getBrainGenome(), null, 2)
    );
  });

  afterEach(() => {
    if (prevGen === undefined) delete process.env.BRAIN_GENOME_PATH;
    else process.env.BRAIN_GENOME_PATH = prevGen;
    _resetBrainGenomeForTests();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('detects Soft SELL spam and builds a genome hypothesis', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    expect(analysis.soft_sell_losses).toBeGreaterThanOrEqual(2);
    expect(analysis.top_pattern?.id).toBe('soft_sell_spam');
    const hypo = buildHypothesis(analysis);
    expect(hypo).toBeTruthy();
    expect(hypo!.patches.length + Object.keys(hypo!.genome_delta || {}).length).toBeGreaterThan(0);
    expect(hypo!.signature.length).toBeGreaterThan(8);
    for (const p of hypo!.patches) {
      expect(isPathAllowed(p.path).ok).toBe(true);
      expect(p.find).not.toBe(p.replace);
    }
  });

  it('skips already-tried signatures and offers an alternate variant', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    const first = buildHypothesis(analysis);
    expect(first).toBeTruthy();
    const exp: BrainExperience = {
      version: 1,
      updated_at: new Date().toISOString(),
      cycles: [],
      patterns: analysis.patterns,
      rejected_signatures: [first!.signature],
      accepted_signatures: [],
      soft_pause_side: null,
      soft_pause_left: 0,
      soft_sell_streak: 0,
      soft_buy_streak: 0,
      last_lesson: '',
    };
    const second = buildHypothesis(analysis, exp);
    expect(second).toBeTruthy();
    expect(second!.signature).not.toBe(first!.signature);
  });

  it('falls back to explore when all pattern variants are exhausted', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    const rejected: string[] = [];
    let sawExplore = false;
    for (let i = 0; i < 30; i++) {
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
      const hypo = buildHypothesis(analysis, exp);
      expect(hypo).toBeTruthy();
      rejected.push(hypo!.signature);
      if (hypo!.pattern_id === 'explore') {
        sawExplore = true;
        break;
      }
    }
    expect(sawExplore).toBe(true);
  });

  it('never returns null while Soft losses exist (even after 50 rejects)', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    const rejected: string[] = [];
    for (let i = 0; i < 50; i++) {
      _resetBrainGenomeForTests({
        peak_keep: 0.88,
        soft_plus_giveback: 0.85,
        peak_arm_soft_mult: 0.5,
        soft_same_side_pause_closes: 12,
        soft_same_side_pause_min: 6,
        explore_step: i,
      });
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
      const hypo = buildHypothesis(analysis, exp);
      expect(hypo).toBeTruthy();
      rejected.push(hypo!.signature);
    }
    expect(new Set(rejected).size).toBe(50);
  });

  it('does not inflate soft_loss count across repeated analyzes', () => {
    const trades = syntheticLessonTrades();
    const a1 = analyzeTrades(trades);
    const a2 = analyzeTrades(trades);
    expect(a1.top_pattern?.count).toBe(a2.top_pattern?.count);
  });
});

describe('brainSelfImprove genome', () => {
  it('sanitizes and clamps knobs', () => {
    const g = sanitizeGenome({ peak_keep: 1.5, soft_plus_giveback: 0.1 });
    expect(g.peak_keep).toBeLessThanOrEqual(0.95);
    expect(g.soft_plus_giveback).toBeGreaterThanOrEqual(0.55);
  });

  it('fills missing trading-intel fields from factory (backward compatible)', () => {
    const g = sanitizeGenome({ peak_keep: 0.75 } as Partial<import('./brainGenome.js').BrainGenome>);
    expect(g.regime_reversal).toBe(0.0016);
    expect(g.regime_trend_enter).toBe(0.00038);
    expect(g.regime_min_dwell_bars).toBe(5);
    expect(g.mtf_htf_veto).toBe(true);
    expect(g.entry_story_conf_min).toBe(0.55);
  });

  it('clamps regime bands and repairs ladder order', () => {
    const g = sanitizeGenome({
      regime_move: 0.002,
      regime_trend_stay: 0.0001,
      regime_trend_enter: 0.00005,
      regime_pullback: 0.00004,
      regime_reversal: 0.00003,
    });
    expect(g.regime_move).toBeLessThanOrEqual(0.0002);
    expect(g.regime_move).toBeLessThan(g.regime_trend_stay);
    expect(g.regime_trend_stay).toBeLessThan(g.regime_trend_enter);
    expect(g.regime_trend_enter).toBeLessThan(g.regime_pullback);
    expect(g.regime_pullback).toBeLessThan(g.regime_reversal);
  });

  it('repairs collapsed ladder with real atstarpes — not one-candle-all-regimes', () => {
    const g = sanitizeGenome({
      regime_move: 0.0001,
      regime_trend_stay: 0.000105, // tiny gap after move
      regime_trend_enter: 0.00011,
      regime_pullback: 0.000115,
      regime_reversal: 0.00012,
      regime_compress_abs: 0.00009,
      regime_expand_abs: 0.00015,
      regime_persist_enter: 0.5,
      regime_persist_stay: 0.49,
    });
    expect(g.regime_trend_stay - g.regime_move).toBeGreaterThanOrEqual(0.000099);
    expect(g.regime_trend_enter - g.regime_trend_stay).toBeGreaterThanOrEqual(0.000099);
    expect(g.regime_pullback - g.regime_trend_enter).toBeGreaterThanOrEqual(0.000099);
    expect(g.regime_reversal - g.regime_pullback).toBeGreaterThanOrEqual(0.0005);
    expect(g.regime_expand_abs - g.regime_compress_abs).toBeGreaterThanOrEqual(0.00035);
    expect(g.regime_persist_enter - g.regime_persist_stay).toBeGreaterThanOrEqual(0.049);
  });

  it('explore can mutate regime_reversal / multi-TF knobs', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    const rejected: string[] = [];
    let sawIntel = false;
    for (let i = 0; i < 40; i++) {
      _resetBrainGenomeForTests({ explore_step: i });
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
      const hypo = buildHypothesis(analysis, exp);
      expect(hypo).toBeTruthy();
      rejected.push(hypo!.signature);
      const keys = Object.keys(hypo!.genome_delta || {});
      if (
        keys.some(
          (k) =>
            k.startsWith('regime_') ||
            k.startsWith('mtf_') ||
            k === 'entry_story_conf_min' ||
            k === 'entry_chop_conf_max'
        )
      ) {
        sawIntel = true;
        break;
      }
    }
    expect(sawIntel).toBe(true);
  });
});

describe('brainSelfImprove cycle (once)', () => {
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-si-'));
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    // Nested vitest from evaluate would re-enter this file — skip in unit cycle test.
    process.env.BRAIN_SKIP_NESTED_TESTS = '1';
    patchSnapshots.clear();
    for (const p of patchTargets) {
      try {
        patchSnapshots.set(p, fs.readFileSync(p, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    _resetBrainGenomeForTests({
      peak_keep: 0.75,
      peak_arm_soft_mult: 1,
      soft_plus_giveback: 0.75,
      wait_on_1m_fight: true,
      require_1m_trigger: true,
    });
    setBrainGenome(getBrainGenome());
    const empty: BrainExperience = {
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
    };
    saveExperience(empty);
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

  it('runs one cycle and records ACCEPTED or REJECTED or SKIPPED', async () => {
    const result = await runBrainCycle({
      trades: syntheticLessonTrades(),
      once: true,
    });
    expect(['ACCEPTED', 'REJECTED', 'SKIPPED']).toContain(result.decision);
    const exp = loadExperience();
    expect(exp.cycles.length).toBeGreaterThanOrEqual(1);
    if (result.decision === 'REJECTED' || result.decision === 'ACCEPTED') {
      expect(wasAlreadyTried(exp, result.signature)).toBe(true);
    }
    expect(
      hypothesisSignature({
        pattern_id: 'x',
        patches: [
          {
            path: 'data/brain-self-improve/genome.json',
            find: 'a',
            replace: 'b',
            note: 'n',
          },
        ],
      }).length
    ).toBe(24);
  }, 60_000);
});
