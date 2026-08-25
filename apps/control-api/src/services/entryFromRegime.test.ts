import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  decideEntryFrom10sRegime,
  recentImpulse,
  signalBarTooLate,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0): TenSecBar {
  const high = Math.max(open, close) + 2;
  const low = Math.min(open, close) - 1;
  return { open_time_ms: i * 300_000, open, high, low, close, ticks: 12 };
}

// ~0.2% bodies — clear on 5m thresholds
const dip = bar(4600, 4590);
const rally = bar(4600, 4610);

describe('5m quality entry', () => {
  it('skips chop: RANGE / UNKNOWN / FADE / REVERSAL', () => {
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'COMPRESSION')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'FAILED_BREAKOUT_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'REVERSAL_CANDIDATE')).toBeNull();
  });

  it('TREND_UP only dip-buys', () => {
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(rally, 'TREND_UP')).toBeNull();
  });

  it('TREND_DOWN only rally-sells', () => {
    expect(decideEntryFrom10sRegime(rally, 'TREND_DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(dip, 'TREND_DOWN')).toBeNull();
  });

  it('EXPANSION / BREAKOUT follow clear body', () => {
    expect(decideEntryFrom10sRegime(rally, 'EXPANSION')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'EXPANSION')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(rally, 'BREAKOUT_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'BREAKOUT_DOWN')?.direction).toBe('SELL');
  });

  it('rejects late exhausted 5m bar', () => {
    const late = bar(4600, 4625); // ~0.54%
    expect(signalBarTooLate(late)).toBe(true);
    expect(decideEntryFrom10sRegime(late, 'BREAKOUT_UP')).toBeNull();
  });

  it('quiet bar is never a trade', () => {
    const quiet: TenSecBar = {
      open_time_ms: 0,
      open: 4600,
      high: 4600.5,
      low: 4599.7,
      close: 4600.2,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(quiet, 'TREND_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'EXPANSION')).toBeNull();
  });
});

describe('no SELL into fresh buy impulse', () => {
  const buySpike: TenSecBar[] = [
    bar(4600, 4605, 0),
    bar(4605, 4615, 1),
    bar(4615, 4625, 2),
  ];

  it('detects strong UP impulse', () => {
    expect(recentImpulse(buySpike).dir).toBe('UP');
  });

  it('blocks SELL after buy spike', () => {
    expect(allowEntryAgainstImpulse('SELL', buySpike).ok).toBe(false);
    expect(allowEntryAgainstImpulse('BUY', buySpike).ok).toBe(true);
  });
});
