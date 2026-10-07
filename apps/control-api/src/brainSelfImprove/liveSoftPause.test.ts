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

describe('noteLiveSoftClose — live Soft pause memory', () => {
  const prevExp = process.env.BRAIN_EXPERIENCE_PATH;
  const prevGen = process.env.BRAIN_GENOME_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-soft-'));
    process.env.BRAIN_EXPERIENCE_PATH = path.join(tmp, 'experience.json');
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    _resetBrainGenomeForTests({
      soft_same_side_pause_min: 2,
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

  it('arms Soft SELL pause after pause_min Soft losses (live desk path)', () => {
    expect(getSoftPauseSide()).toBeNull();
    noteLiveSoftClose('SELL', true);
    expect(getSoftPauseSide()).toBeNull(); // need 2
    const second = noteLiveSoftClose('SELL', true);
    expect(second.soft_pause_side).toBe('SELL');
    expect(second.soft_pause_left).toBeGreaterThan(0);
    expect(getSoftPauseSide()).toBe('SELL');
  });

  it('Peak/scratch win does NOT clear Soft BUY pause (Soft spam re-arm fix)', () => {
    noteLiveSoftClose('BUY', true);
    noteLiveSoftClose('BUY', true);
    expect(getSoftPauseSide()).toBe('BUY');
    // +£0.45 Peak must not wipe Soft memory — that re-armed Soft BUY spam
    noteLiveSoftClose('BUY', false);
    expect(getSoftPauseSide()).toBe('BUY');
  });

  it('Soft pause expires after pause_closes countdown, then streak resets', () => {
    noteLiveSoftClose('BUY', true);
    noteLiveSoftClose('BUY', true);
    expect(getSoftPauseSide()).toBe('BUY');
    // pause_closes=3; each close consumes one (incl Soft/Peak)
    noteLiveSoftClose('BUY', false); // left 3→2, Peak does not clear
    noteLiveSoftClose('BUY', false); // 2→1
    noteLiveSoftClose('BUY', false); // 1→0 clear
    expect(getSoftPauseSide()).toBeNull();
  });
});
