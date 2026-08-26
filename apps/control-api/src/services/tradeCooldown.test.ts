import { describe, expect, it, beforeEach } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
  EPIC_LOSS_PAUSE_MS,
  EPIC_SAME_SIDE_BLOCK_MS,
  pauseMsAfterClose,
} from './tradeCooldown.js';

describe('epic anti-whipsaw cooldown', () => {
  beforeEach(() => resetEpicTradeCooldowns());

  it('profit pause = 45s, loss/scratch pause = 60s', () => {
    expect(EPIC_PAUSE_MS).toBe(45_000);
    expect(EPIC_LOSS_PAUSE_MS).toBe(60_000);
    expect(EPIC_SAME_SIDE_BLOCK_MS).toBe(60_000);
    expect(pauseMsAfterClose(false)).toBe(45_000);
    expect(pauseMsAfterClose(true)).toBe(60_000);
  });

  it('blocks re-entry inside pause after profit close', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    const g = allowEpicReentry('GOLD', 'BUY');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/EPIC pause|after profit/);
  });

  it('blocks opposite flip after close', () => {
    noteEpicTradeClose('GOLD', 'SELL', true);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(false);
    expect(allowEpicReentry('GOLD', 'BUY').reason).toMatch(/no-flip|pause/);
  });

  it('uses longer pause after a loss/scratch', () => {
    expect(EPIC_LOSS_PAUSE_MS).toBeGreaterThan(EPIC_PAUSE_MS);
    noteEpicTradeClose('GOLD', 'BUY', true);
    const g = allowEpicReentry('gold', 'BUY');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/after loss/);
  });

  it('blocks same-side reopen (no “to pašu treidu” spam)', () => {
    noteEpicTradeClose('GOLD', 'SELL', true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(false);
    expect(allowEpicReentry('GOLD', 'SELL').reason).toMatch(/pause|no-repeat/);
  });
});
