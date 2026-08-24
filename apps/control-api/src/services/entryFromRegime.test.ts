import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime, decideEntryBreakoutOnly } from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number): TenSecBar {
  const high = Math.max(open, close) + 0.8;
  const low = Math.min(open, close) - 0.4;
  return { open_time_ms: 0, open, high, low, close, ticks: 12 };
}

const dip = bar(2000, 1996); // ~0.2% down — moving
const rally = bar(2000, 2004);

describe('10s + 14-regime suitable entry', () => {
  it('waits in UNKNOWN / COMPRESSION / TRANSITION', () => {
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'COMPRESSION')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'TRANSITION')).toBeNull();
  });

  it('TREND_UP only dip-buys — never sells the rally', () => {
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP')?.setup).toBe('PULLBACK');
    expect(decideEntryFrom10sRegime(rally, 'TREND_UP')).toBeNull();
  });

  it('TREND_DOWN only rally-sells — never buys the dump', () => {
    expect(decideEntryFrom10sRegime(rally, 'TREND_DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(dip, 'TREND_DOWN')).toBeNull();
  });

  it('PULLBACK_UPTREND resumes long on the turn-up bar', () => {
    expect(decideEntryFrom10sRegime(rally, 'PULLBACK_UPTREND')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(rally, 'PULLBACK_UPTREND')?.setup).toBe('CONTINUATION');
    expect(decideEntryFrom10sRegime(dip, 'PULLBACK_UPTREND')).toBeNull();
  });

  it('BREAKOUT_UP follows up, not the failed red bar', () => {
    expect(decideEntryFrom10sRegime(rally, 'BREAKOUT_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'BREAKOUT_UP')).toBeNull();
  });

  it('FAILED_BREAKOUT_UP fades — SELL, not chase', () => {
    expect(decideEntryFrom10sRegime(dip, 'FAILED_BREAKOUT_UP')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(rally, 'FAILED_BREAKOUT_UP')).toBeNull();
  });

  it('RANGE still mean-reverts on a real 10s body', () => {
    expect(decideEntryFrom10sRegime(dip, 'RANGE')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(rally, 'RANGE')?.direction).toBe('SELL');
  });

  it('RANGE ignores micro Capital noise bodies', () => {
    // ~0.02% body — below hardened RANGE threshold 0.028%
    const micro = bar(4519, 4518.1);
    expect(decideEntryFrom10sRegime(micro, 'RANGE')).toBeNull();
  });

  it('quiet bar is never a trade in any regime', () => {
    const quiet: TenSecBar = {
      open_time_ms: 0,
      open: 2000,
      high: 2000.1,
      low: 1999.95,
      close: 2000.05,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(quiet, 'TREND_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'BREAKOUT_UP')).toBeNull();
  });
});

describe('breakout + trend entry', () => {
  it('arms on BREAKOUT_UP/DOWN', () => {
    expect(decideEntryBreakoutOnly(rally, 'BREAKOUT_UP')?.direction).toBe('BUY');
    expect(decideEntryBreakoutOnly(dip, 'BREAKOUT_DOWN')?.direction).toBe('SELL');
  });

  it('arms on TREND_UP dip and TREND_DOWN rally', () => {
    expect(decideEntryBreakoutOnly(dip, 'TREND_UP')?.direction).toBe('BUY');
    expect(decideEntryBreakoutOnly(dip, 'TREND_UP')?.setup).toBe('PULLBACK');
    expect(decideEntryBreakoutOnly(rally, 'TREND_DOWN')?.direction).toBe('SELL');
    expect(decideEntryBreakoutOnly(rally, 'TREND_DOWN')?.setup).toBe('PULLBACK');
  });

  it('ignores EXPANSION / range / failed / reversal (not live)', () => {
    expect(decideEntryBreakoutOnly(rally, 'EXPANSION')).toBeNull();
    expect(decideEntryBreakoutOnly(dip, 'RANGE')).toBeNull();
    expect(decideEntryBreakoutOnly(dip, 'FAILED_BREAKOUT_UP')).toBeNull();
    expect(decideEntryBreakoutOnly(rally, 'REVERSAL_CANDIDATE')).toBeNull();
  });

  it('structural fallback buys when hist close breaks prior highs', () => {
    const hist: TenSecBar[] = [
      { open_time_ms: 0, open: 4620.0, high: 4620.4, low: 4619.8, close: 4620.2, ticks: 10 },
      { open_time_ms: 10_000, open: 4620.2, high: 4620.6, low: 4620.0, close: 4620.5, ticks: 10 },
      { open_time_ms: 20_000, open: 4620.5, high: 4621.0, low: 4620.3, close: 4620.9, ticks: 10 },
      { open_time_ms: 30_000, open: 4620.9, high: 4622.2, low: 4620.8, close: 4622.0, ticks: 10 },
    ];
    const last = hist[hist.length - 1]!;
    expect(decideEntryBreakoutOnly(last, 'COMPRESSION', hist)?.direction).toBe('BUY');
    expect(decideEntryBreakoutOnly(last, 'COMPRESSION', hist)?.reason).toMatch(/STRUCT BO long/);
  });

  it('arms Gold-scale BREAKOUT_UP body under classic 0.015% gate', () => {
    // 0.35pt @ 4621 ≈ 0.0076% — old isMoving10s would reject
    const goldBo: TenSecBar = {
      open_time_ms: 0,
      open: 4621.0,
      high: 4621.5,
      low: 4620.9,
      close: 4621.35,
      ticks: 12,
    };
    expect(decideEntryBreakoutOnly(goldBo, 'BREAKOUT_UP')?.direction).toBe('BUY');
  });
});
