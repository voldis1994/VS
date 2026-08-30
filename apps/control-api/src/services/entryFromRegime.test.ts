import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
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
