import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSoftPauseSide,
  noteLiveSoftClose,
  saveExperience,
  type BrainExperience,
} from './experience.js';
import { _resetBrainGenomeForTests, getBrainGenome, setBrainGenome } from './brainGenome.js';

function emptyExp(): BrainExperience {
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
  };
}

describe('noteLiveSoftClose — live Soft pause memory (brain Soft spam governor)', () => {
  const prevExp = process.env.BRAIN_EXPERIENCE_PATH;
  const prevGen = process.env.BRAIN_GENOME_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-soft-'));
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    _resetBrainGenomeForTests({
      soft_same_side_pause_min: 1,
      soft_same_side_pause_closes: 3,
    });
    setBrainGenome(getBrainGenome());
    saveExperience(emptyExp());
  });

  afterEach(() => {
    if (prevExp === undefined) delete process.env.BRAIN_EXPERIENCE_PATH;
    else process.env.BRAIN_EXPERIENCE_PATH = prevExp;
    if (prevGen === undefined) delete process.env.BRAIN_GENOME_PATH;
    else process.env.BRAIN_GENOME_PATH = prevGen;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('arms Soft BUY pause on first Soft loss (pause_min=1 — brain, not flipFilter)', () => {
    expect(getSoftPauseSide()).toBeNull();
    const first = noteLiveSoftClose('BUY', true);
    expect(first.soft_pause_side).toBe('BUY');
    expect(first.soft_pause_left).toBeGreaterThan(0);
    expect(getSoftPauseSide()).toBe('BUY');
  });

  it('Peak/scratch win does NOT clear Soft pause (was Soft BUY spam re-arm)', () => {
    noteLiveSoftClose('BUY', true);
    expect(getSoftPauseSide()).toBe('BUY');
    const left = noteLiveSoftClose('BUY', false); // Peak +£0.45
    // Counts down one close, but Soft memory stays
    expect(left.soft_pause_side).toBe('BUY');
    expect(getSoftPauseSide()).toBe('BUY');
  });

  it('pause expires only after pause_closes non-Soft countdown', () => {
    noteLiveSoftClose('SELL', true);
    expect(getSoftPauseSide()).toBe('SELL');
    noteLiveSoftClose('SELL', false);
    noteLiveSoftClose('SELL', false);
    noteLiveSoftClose('SELL', false);
    expect(getSoftPauseSide()).toBeNull();
  });
});
