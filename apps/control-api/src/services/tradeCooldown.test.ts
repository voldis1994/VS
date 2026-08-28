import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
} from './tradeCooldown.js';

describe('epic reentry — no cooldown', () => {
  beforeEach(() => {
    resetEpicTradeCooldowns();
  });

  it('pause is disabled (0ms)', () => {
    expect(EPIC_PAUSE_MS).toBe(0);
  });

  it('allows SAME-side reentry immediately after close', () => {
    noteEpicTradeClose('GOLD', 'BUY', true, 1);
    const ok = allowEpicReentry('GOLD', 'BUY', 1);
    expect(ok.ok).toBe(true);
    expect(ok.reason).toMatch(/no cooldown/i);
  });

  it('allows OPPOSITE-side FLIP immediately', () => {
    noteEpicTradeClose('GOLD', 'BUY', true, 2);
    const flip = allowEpicReentry('GOLD', 'SELL', 2);
    expect(flip.ok).toBe(true);
  });

  it('isolates close notes per client+epic', () => {
    noteEpicTradeClose('GOLD', 'BUY', true, 1);
    noteEpicTradeClose('GOLD', 'SELL', false, 2);
    expect(allowEpicReentry('GOLD', 'BUY', 1).ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL', 2).ok).toBe(true);
  });
});
