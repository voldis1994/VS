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

  it('pause is 10s after any close (same side)', () => {
    expect(EPIC_PAUSE_MS).toBe(10_000);
    expect(EPIC_LOSS_PAUSE_MS).toBe(10_000);
    expect(pauseMsAfterClose(false)).toBe(10_000);
    expect(pauseMsAfterClose(true)).toBe(10_000);
  });

  it('blocks SAME-side reentry immediately after close', () => {
    noteEpicTradeClose('GOLD', 'BUY', true);
    const blocked = allowEpicReentry('GOLD', 'BUY');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/REENTRY PAUSE/);
  });

  it('allows OPPOSITE-side FLIP immediately (bad BUY → SELL on dump)', () => {
    noteEpicTradeClose('GOLD', 'BUY', true);
    const flip = allowEpicReentry('GOLD', 'SELL');
    expect(flip.ok).toBe(true);
    expect(flip.reason).toMatch(/FLIP/i);
    // same side still blocked
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(false);
  });

  it('blocks SAME-side EARLY reentry for 10s', () => {
    noteEpicTradeClose('GOLD', 'BUY', true);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(false);
    vi.advanceTimersByTime(9_000);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
  });

  it('allows same-side reentry after 10s pause', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(false);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(true);
  });
});
