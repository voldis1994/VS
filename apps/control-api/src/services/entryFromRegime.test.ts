import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number): TenSecBar {
  const high = Math.max(open, close) + Math.abs(open) * 0.001;
  const low = Math.min(open, close) - Math.abs(open) * 0.0005;
  return { open_time_ms: 0, open, high, low, close, ticks: 12 };
}

const ctx = { playbookAgeBars: 5, regimeAgeBars: 5 };
const longDip = bar(2000, 1998.8);
const longRally = bar(2000, 2001.2);
const scalpRally = bar(2000, 2000.8);
const quiet: TenSecBar = {
  open_time_ms: 0,
  open: 2000,
  high: 2000.1,
  low: 1999.95,
  close: 2000.05,
  ticks: 8,
};

describe('10s playbook suitable entry', () => {
  it('waits in UNKNOWN / COMPRESSION / TRANSITION', () => {
    expect(decideEntryFrom10sRegime(longDip, 'UNKNOWN', ctx)).toBeNull();
    expect(decideEntryFrom10sRegime(longDip, 'COMPRESSION', ctx)).toBeNull();
    expect(decideEntryFrom10sRegime(longRally, 'TRANSITION', ctx)).toBeNull();
  });

  it('TREND_UP only dip-buys — never sells the rally', () => {
    expect(decideEntryFrom10sRegime(longDip, 'TREND_UP', ctx)?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(longDip, 'TREND_UP', ctx)?.playbook).toBe('LONG');
    expect(decideEntryFrom10sRegime(longRally, 'TREND_UP', ctx)).toBeNull();
  });

  it('TREND_DOWN only rally-sells', () => {
    expect(decideEntryFrom10sRegime(longRally, 'TREND_DOWN', ctx)?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(longDip, 'TREND_DOWN', ctx)).toBeNull();
  });

  it('PULLBACK_UPTREND resumes long on rally', () => {
    expect(decideEntryFrom10sRegime(longRally, 'PULLBACK_UPTREND', ctx)?.setup).toBe(
      'CONTINUATION'
    );
    expect(decideEntryFrom10sRegime(longDip, 'PULLBACK_UPTREND', ctx)).toBeNull();
  });

  it('BREAKOUT_UP follows as SCALP', () => {
    expect(decideEntryFrom10sRegime(scalpRally, 'BREAKOUT_UP', ctx)?.playbook).toBe('SCALP');
    expect(decideEntryFrom10sRegime(longDip, 'BREAKOUT_UP', ctx)).toBeNull();
  });

  it('quiet bar is never a trade', () => {
    expect(decideEntryFrom10sRegime(quiet, 'TREND_UP', ctx)).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'RANGE', ctx)).toBeNull();
  });
});
