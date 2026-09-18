import { describe, expect, it } from 'vitest';
import {
  assertRegimeBandsCoherent,
  bandPts,
  COMPRESS_ABS,
  ENTRY_DIP,
  ENTRY_RALLY,
  EXPAND_ABS,
  MOVE,
  MOVE_RANGE,
  PULLBACK,
  REVERSAL,
  TREND_ENTER,
  TREND_STAY,
} from './regimeBands.js';
import { isMoving10s } from './tenSecondOhlc.js';
import type { TenSecBar } from './tenSecondOhlc.js';

describe('regimeBands — one ladder that actually works together', () => {
  it('assertRegimeBandsCoherent passes (module load already ran it)', () => {
    expect(() => assertRegimeBandsCoherent()).not.toThrow();
  });

  it('strict body order with real Gold~2650 point gaps', () => {
    const mid = 2650;
    const ladder = [
      ['MOVE', MOVE],
      ['TREND_STAY', TREND_STAY],
      ['TREND_ENTER', TREND_ENTER],
      ['PULLBACK', PULLBACK],
      ['REVERSAL', REVERSAL],
    ] as const;
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]![1]).toBeGreaterThan(ladder[i - 1]![1]);
    }
    // Stay must be ABOVE move (old bug: stay 0.010% < sign 0.012%)
    expect(TREND_STAY).toBeGreaterThan(MOVE);
    expect(bandPts(TREND_STAY, mid) - bandPts(MOVE, mid)).toBeGreaterThanOrEqual(0.15);
    expect(bandPts(TREND_ENTER, mid) - bandPts(TREND_STAY, mid)).toBeGreaterThanOrEqual(0.35);
    expect(bandPts(PULLBACK, mid) - bandPts(TREND_ENTER, mid)).toBeGreaterThanOrEqual(0.35);
    expect(bandPts(REVERSAL, mid) - bandPts(PULLBACK, mid)).toBeGreaterThanOrEqual(2.5);
  });

  it('range ladder: compress < move < expand, with dead zone', () => {
    expect(COMPRESS_ABS).toBeLessThan(MOVE);
    expect(MOVE_RANGE).toBeGreaterThanOrEqual(MOVE);
    expect(MOVE_RANGE).toBeLessThanOrEqual(TREND_STAY);
    expect(EXPAND_ABS).toBeGreaterThan(TREND_ENTER);
    expect(EXPAND_ABS - COMPRESS_ABS).toBeGreaterThanOrEqual(0.00035);
  });

  it('entry dip/rally === ±MOVE (same floor as isMoving body)', () => {
    expect(ENTRY_RALLY).toBe(MOVE);
    expect(ENTRY_DIP).toBe(-MOVE);
  });

  it('isMoving uses the same MOVE / MOVE_RANGE constants', () => {
    const quiet: TenSecBar = {
      open_time_ms: 0,
      open: 2650,
      high: 2650.1,
      low: 2649.95,
      close: 2650.05,
      ticks: 5,
    };
    expect(Math.abs((quiet.close - quiet.open) / quiet.open)).toBeLessThan(MOVE);
    expect(isMoving10s(quiet)).toBe(false);

    const moving: TenSecBar = {
      open_time_ms: 0,
      open: 2650,
      high: 2650.6,
      low: 2649.9,
      close: 2650 + 2650 * MOVE * 1.05,
      ticks: 5,
    };
    expect(isMoving10s(moving)).toBe(true);
  });

  it('printed Gold ladder (sanity for operators)', () => {
    const mid = 2650;
    const rows = {
      compress_pt: bandPts(COMPRESS_ABS, mid),
      move_pt: bandPts(MOVE, mid),
      stay_pt: bandPts(TREND_STAY, mid),
      enter_pt: bandPts(TREND_ENTER, mid),
      pullback_pt: bandPts(PULLBACK, mid),
      expand_pt: bandPts(EXPAND_ABS, mid),
      reversal_pt: bandPts(REVERSAL, mid),
    };
    // Rough Gold 10s scales — not exact market, just order of magnitude
    expect(rows.move_pt).toBeCloseTo(0.32, 1);
    expect(rows.enter_pt).toBeCloseTo(1.0, 0);
    expect(rows.pullback_pt).toBeGreaterThan(rows.enter_pt);
    expect(rows.reversal_pt).toBeGreaterThan(3);
  });
});
