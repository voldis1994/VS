import { describe, expect, it, beforeEach } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
  EPIC_LOSS_PAUSE_MS,
  pauseMsAfterClose,
} from './tradeCooldown.js';

describe('epic anti-whipsaw cooldown', () => {
  beforeEach(() => resetEpicTradeCooldowns());

  it('profit pause = 10s, loss pause = 30s', () => {
    expect(EPIC_PAUSE_MS).toBe(10_000);
    expect(EPIC_LOSS_PAUSE_MS).toBe(30_000);
    expect(pauseMsAfterClose(false)).toBe(10_000);
    expect(pauseMsAfterClose(true)).toBe(30_000);
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

  it('uses longer pause after a loss', () => {
    expect(EPIC_LOSS_PAUSE_MS).toBeGreaterThan(EPIC_PAUSE_MS);
    noteEpicTradeClose('GOLD', 'BUY', true);
    const g = allowEpicReentry('gold', 'BUY');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/after loss/);
  });
});
