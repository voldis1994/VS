import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  allowEpicReentry,
  noteEpicTradeClose,
  resetEpicTradeCooldowns,
  EPIC_PAUSE_MS,
  EPIC_LOSS_PAUSE_MS,
  pauseMsAfterClose,
} from './tradeCooldown.js';

describe('epic — 0s pause but must flip (no BUY→BUY / SELL→SELL)', () => {
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

  it('after BUY close: SELL ok, BUY blocked', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(true);
    const same = allowEpicReentry('GOLD', 'BUY');
    expect(same.ok).toBe(false);
    expect(same.reason).toMatch(/must flip|BUY→BUY/);
  });

  it('after SELL close: BUY ok, SELL blocked', () => {
    noteEpicTradeClose('GOLD', 'SELL', true);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(false);
  });

  it('after opposite close, previous side allowed again', () => {
    noteEpicTradeClose('GOLD', 'BUY', false);
    noteEpicTradeClose('GOLD', 'SELL', false);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(true);
    expect(allowEpicReentry('GOLD', 'SELL').ok).toBe(false);
  });
});
