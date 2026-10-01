import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FACTORY_RESET_CONFIRM,
  factoryResetLearning,
} from './factoryResetLearning.js';
import {
  getBrainGenome,
  setBrainGenome,
  _resetBrainGenomeForTests,
} from '../brainSelfImprove/brainGenome.js';
import { getDeskCalibration, setDeskCalibration } from './deskCalibration.js';
import { _resetDeskCalibrationCacheForTests } from './deskCalibration.js';
import { _resetLearnerForTests } from './deskLearner.js';
import { _resetEntryLearnerForTests } from './entryLearner.js';
import { _resetAutoCalibrateForTests } from './autoCalibrate.js';
import { _resetRobotSessionsForTests } from './robotDesk.js';

describe('factoryResetLearning', () => {
  const prevGenome = process.env.BRAIN_GENOME_PATH;
  const prevExp = process.env.BRAIN_EXPERIENCE_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-reset-'));
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    _resetRobotSessionsForTests();
    _resetDeskCalibrationCacheForTests();
    _resetAutoCalibrateForTests(0);
    _resetLearnerForTests(0);
    _resetEntryLearnerForTests(0);
    _resetBrainGenomeForTests({
      soft_l1_abs: 0.5,
      peak_keep: 0.9,
      last_lesson: 'dirty mess',
    });
    setDeskCalibration({ hardinv_abs: 9, peak_retention: 0.9, target_abs: 20 });
  });

  afterEach(() => {
    if (prevGenome === undefined) delete process.env.BRAIN_GENOME_PATH;
    else process.env.BRAIN_GENOME_PATH = prevGenome;
    if (prevExp === undefined) delete process.env.BRAIN_EXPERIENCE_PATH;
    else process.env.BRAIN_EXPERIENCE_PATH = prevExp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects wrong confirm phrase', async () => {
    await expect(
      factoryResetLearning({ confirm: 'yes', wipe_db_history: false })
    ).rejects.toThrow(/LEARN_FROM_SCRATCH/);
  });

  it('resets genome + desk Soft/Peak/Target to factory defaults', async () => {
    const r = await factoryResetLearning({
      confirm: FACTORY_RESET_CONFIRM,
      wipe_db_history: false,
      wipe_brain_history: false,
    });
    expect(r.ok).toBe(true);
    expect(r.db_history_wiped).toBe(false);

    const g = getBrainGenome();
    expect(g.soft_l1_abs).toBe(1.2);
    expect(g.peak_keep).toBe(0.75);
    expect(g.last_lesson).toMatch(/FACTORY LEARN_FROM_SCRATCH/);

    const cal = getDeskCalibration();
    expect(cal.hardinv_abs).toBe(2.2);
    expect(cal.peak_retention).toBe(0.75);
    expect(cal.target_abs).toBe(5.0);
    expect(cal.safety_tp_rr).toBe(1.5);
    expect(cal.entry_filter_level).toBe(0);
  });
});
