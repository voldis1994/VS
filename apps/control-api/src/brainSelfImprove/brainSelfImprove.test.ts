import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  HARDINV_PCT_BP_MIN,
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
import {
  isExploreStepOnlyThrash,
  isKeepThrashWhileSoftSpam,
  isNoopShieldThrash,
  isPauseOnlyGenomeThrash,
  isSoftPctOnlyGenomeThrash,
  runBrainCycle,
} from './loop.js';

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

  it('falls back to Soft-first explore when Soft spam variants are exhausted', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    expect(analysis.top_pattern?.id).toBe('soft_sell_spam');
    const rejected: string[] = [];
    let softExplore: ReturnType<typeof buildHypothesis> = null;
    for (let i = 0; i < 40; i++) {
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
      // Soft focus keeps Soft pattern_id — Peak Keep must not be first explore
      if (
        /Explore Soft (pause|pct)|Force Soft explore/i.test(hypo!.title) ||
        (hypo!.genome_delta &&
          ('hardinv_pct_bp' in hypo!.genome_delta ||
            'soft_same_side_pause_closes' in hypo!.genome_delta) &&
          !('peak_keep' in hypo!.genome_delta && Object.keys(hypo!.genome_delta).length <= 3))
      ) {
        // After primary Soft variants exhaust, next must be Soft lever (not Keep-only)
        if (/Explore Soft|Force Soft/i.test(hypo!.title)) {
          softExplore = hypo;
          break;
        }
      }
    }
    expect(softExplore).toBeTruthy();
    expect(softExplore!.pattern_id).toBe('soft_sell_spam');
    expect(softExplore!.title).not.toMatch(/Explore Keep/i);
    expect(
      'hardinv_pct_bp' in (softExplore!.genome_delta || {}) ||
        'soft_same_side_pause_closes' in (softExplore!.genome_delta || {})
    ).toBe(true);
  });

  it('includes Soft pct tighten among Soft SELL variants (before Peak Keep thrash)', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    const rejected: string[] = [];
    const titles: string[] = [];
    for (let i = 0; i < 8; i++) {
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
      titles.push(hypo!.title);
      rejected.push(hypo!.signature);
    }
    expect(titles.some((t) => /Soft pct/i.test(t))).toBe(true);
    const keepIdx = titles.findIndex((t) => /Explore Keep/i.test(t));
    const softPctIdx = titles.findIndex((t) => /Soft pct/i.test(t));
    if (keepIdx >= 0 && softPctIdx >= 0) {
      expect(softPctIdx).toBeLessThan(keepIdx);
    }
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

  it('blocks Keep genome when Soft spam is top pattern', () => {
    // Mirrors live bug: "Slight Keep tighten" ACCEPTed while soft_sell_spam×3
    expect(
      isKeepThrashWhileSoftSpam(true, ['peak_keep', 'require_1m_trigger'], 'Slight Keep tighten')
    ).toBe(true);
    expect(
      isKeepThrashWhileSoftSpam(true, ['require_1m_trigger', 'wait_on_1m_fight'], '1m shields')
    ).toBe(false);
    expect(isKeepThrashWhileSoftSpam(false, ['peak_keep'], 'Keep nudge')).toBe(false);
  });

  it('flags pause-only genome thrash (invisible to replay E)', () => {
    expect(
      isPauseOnlyGenomeThrash([
        'soft_same_side_pause_closes',
        'soft_same_side_pause_min',
        'explore_step',
      ])
    ).toBe(true);
    expect(
      isPauseOnlyGenomeThrash(['soft_same_side_pause_closes', 'require_1m_trigger'])
    ).toBe(false);
    expect(isPauseOnlyGenomeThrash(['hardinv_pct_bp', 'explore_step'])).toBe(false);
    expect(isSoftPctOnlyGenomeThrash(['hardinv_pct_bp', 'explore_step'])).toBe(true);
    expect(isSoftPctOnlyGenomeThrash(['hardinv_pct_bp', 'wait_on_1m_fight'])).toBe(
      false
    );
  });

  it('skips Soft pause explore when pause already at ceiling', () => {
    const analysis = analyzeTrades(syntheticLessonTrades());
    _resetBrainGenomeForTests({
      soft_same_side_pause_closes: 6,
      soft_same_side_pause_min: 3,
      explore_step: 100,
      require_1m_trigger: true,
      wait_on_1m_fight: true,
    });
    const rejected: string[] = [];
    const titles: string[] = [];
    for (let i = 0; i < 6; i++) {
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
      titles.push(hypo!.title);
      rejected.push(hypo!.signature);
    }
    expect(titles.some((t) => /Explore Soft pause/i.test(t))).toBe(false);
    // Shields already ON → never re-propose reinforce (was explore_step ACCEPT thrash)
    expect(titles.some((t) => /reinforce 1m Soft shields/i.test(t))).toBe(false);
    expect(titles.some((t) => /structure|regime|Keep|giveback|arm|Force/i.test(t))).toBe(
      true
    );
  });

  it('blocks no-op Soft shield reinforce when already ON', () => {
    // Live bug: CIKLS #12 ACCEPTed reinforce while wait/require already true
    expect(
      isNoopShieldThrash(
        true,
        ['wait_on_1m_fight', 'require_1m_trigger', 'explore_step'],
        'Explore reinforce 1m Soft shields (step #34184)'
      )
    ).toBe(true);
    expect(
      isNoopShieldThrash(false, ['wait_on_1m_fight', 'require_1m_trigger'], 'reinforce')
    ).toBe(false);
    expect(
      isNoopShieldThrash(true, ['hardinv_pct_bp', 'explore_step'], 'Soft pct')
    ).toBe(false);
  });
});

describe('brainSelfImprove genome', () => {
  it('sanitizes and clamps knobs', () => {
    const g = sanitizeGenome({ peak_keep: 1.5, soft_plus_giveback: 0.1 });
    expect(g.peak_keep).toBeLessThanOrEqual(0.88);
    expect(g.soft_plus_giveback).toBeGreaterThanOrEqual(0.55);
  });

  it('never allows Soft hardinv_pct_bp dust below floor (was 0.1bp suicide)', () => {
    const g = sanitizeGenome({ hardinv_pct_bp: 0.1 });
    expect(g.hardinv_pct_bp).toBeGreaterThanOrEqual(HARDINV_PCT_BP_MIN);
    expect(isExploreStepOnlyThrash(['explore_step', 'version'])).toBe(true);
    expect(isExploreStepOnlyThrash(['hardinv_pct_bp', 'explore_step'])).toBe(false);
  });
});

describe('brainSelfImprove cycle (once)', () => {
  const prevExp = process.env.BRAIN_EXPERIENCE_PATH;
  const prevGen = process.env.BRAIN_GENOME_PATH;
  const prevSkip = process.env.BRAIN_SKIP_NESTED_TESTS;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-si-'));
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    // Nested vitest from evaluate would re-enter this file — skip in unit cycle test.
    process.env.BRAIN_SKIP_NESTED_TESTS = '1';
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
