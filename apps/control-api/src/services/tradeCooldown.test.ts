import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
  EPIC_LOSS_PAUSE_MS,
  pauseMsAfterClose,
} from './tradeCooldown.js';

describe('epic anti machine-gun reentry pause', () => {
  beforeEach(() => {
    resetEpicTradeCooldowns();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pause is 90s after profit or loss', () => {
    expect(EPIC_PAUSE_MS).toBe(90_000);
    expect(EPIC_LOSS_PAUSE_MS).toBe(90_000);
    expect(pauseMsAfterClose(false)).toBe(90_000);
    expect(pauseMsAfterClose(true)).toBe(90_000);
  });

  it('blocks reentry immediately after close', () => {
    noteEpicTradeClose('GOLD', 'BUY', true);
    const blocked = allowEpicReentry('GOLD', 'BUY');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/REENTRY PAUSE/);
  });

  it('allows reentry after pause elapses', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(false);
    vi.advanceTimersByTime(90_000);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(true);
  });
});
