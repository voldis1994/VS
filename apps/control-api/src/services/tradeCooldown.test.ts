import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
  EPIC_LOSS_PAUSE_MS,
  pauseMsAfterClose,
} from './tradeCooldown.js';

describe('epic — no post-trade cooldown', () => {
  beforeEach(() => {
    resetEpicTradeCooldowns();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('all pauses are 0s', () => {
    expect(EPIC_PAUSE_MS).toBe(0);
    expect(EPIC_LOSS_PAUSE_MS).toBe(0);
    expect(pauseMsAfterClose(false)).toBe(0);
    expect(pauseMsAfterClose(true)).toBe(0);
  });

  it('allows opposite immediately after close', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(true);
  });

  it('allows same side immediately (no must-flip)', () => {
    noteEpicTradeClose('GOLD', 'BUY', true);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(true);
  });
});
