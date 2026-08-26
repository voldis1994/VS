import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
  EPIC_LOSS_PAUSE_MS,
  pauseMsAfterClose,
} from './tradeCooldown.js';

describe('epic must-flip cooldown', () => {
  beforeEach(() => {
    resetEpicTradeCooldowns();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('profit pause = 15s, loss/scratch = 20s', () => {
    expect(EPIC_PAUSE_MS).toBe(15_000);
    expect(EPIC_LOSS_PAUSE_MS).toBe(20_000);
    expect(pauseMsAfterClose(false)).toBe(15_000);
    expect(pauseMsAfterClose(true)).toBe(20_000);
  });

  it('blocks during pause', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(false);
    expect(allowEpicReentry('GOLD', 'SELL').reason).toMatch(/pause/);
  });

  it('after pause: same side blocked, opposite allowed (no 5× identical)', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    vi.advanceTimersByTime(EPIC_PAUSE_MS + 100);
    const same = allowEpicReentry('GOLD', 'BUY');
    expect(same.ok).toBe(false);
    expect(same.reason).toMatch(/must flip|no same-side/);
    const flip = allowEpicReentry('GOLD', 'SELL');
    expect(flip.ok).toBe(true);
  });

  it('after opposite close, previous side becomes allowed again', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    vi.advanceTimersByTime(EPIC_PAUSE_MS + 100);
    noteEpicTradeClose('GOLD', 'SELL', false);
    vi.advanceTimersByTime(EPIC_PAUSE_MS + 100);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(false);
  });
});
