import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { type TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, pad = 0.15): TenSecBar {
  const high = Math.max(open, close) + pad;
  const low = Math.min(open, close) - pad * 0.5;
  return { open_time_ms: 0, open, high, low, close, ticks: 12 };
}

/** ~0.2% — SPIKE */
const spikeDip = bar(2000, 1996, 0.8);
const spikeRally = bar(2000, 2004, 0.8);
/** ~0.025% — MOVING micro */
const microDip = bar(2000, 1999.5, 0.12);
const microRally = bar(2000, 2000.5, 0.12);

describe('10s + 14-regime suitable entry', () => {
  it('RANGE/COMPRESSION/TRANSITION never open-fade (green→SELL / red→BUY Soft)', () => {
    expect(decideEntryFrom10sRegime(microDip, 'COMPRESSION')).toBeNull();
    expect(decideEntryFrom10sRegime(microRally, 'COMPRESSION')).toBeNull();
    expect(decideEntryFrom10sRegime(microDip, 'TRANSITION')).toBeNull();
    expect(decideEntryFrom10sRegime(microRally, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(microDip, 'RANGE')).toBeNull();
  });

  it('waits in UNKNOWN and chop', () => {
    expect(decideEntryFrom10sRegime(spikeDip, 'UNKNOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(microRally, 'TRANSITION')).toBeNull();
  });

  it('TREND_UP follows green only — never red→BUY dip knife', () => {
    expect(decideEntryFrom10sRegime(spikeRally, 'TREND_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(spikeRally, 'TREND_UP')?.setup).toBe('CONTINUATION');
    expect(decideEntryFrom10sRegime(spikeDip, 'TREND_UP')).toBeNull();
  });

  it('TREND_DOWN follows red only — never green→SELL rally knife', () => {
    expect(decideEntryFrom10sRegime(spikeDip, 'TREND_DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(spikeDip, 'TREND_DOWN')?.setup).toBe('CONTINUATION');
    expect(decideEntryFrom10sRegime(spikeRally, 'TREND_DOWN')).toBeNull();
  });

  it('PULLBACK_UPTREND resumes long on the turn-up bar', () => {
    expect(decideEntryFrom10sRegime(spikeRally, 'PULLBACK_UPTREND')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(spikeRally, 'PULLBACK_UPTREND')?.setup).toBe('CONTINUATION');
    expect(decideEntryFrom10sRegime(spikeDip, 'PULLBACK_UPTREND')).toBeNull();
  });

  it('BREAKOUT_UP follows up, not the failed red bar', () => {
    expect(decideEntryFrom10sRegime(spikeRally, 'BREAKOUT_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(spikeDip, 'BREAKOUT_UP')).toBeNull();
  });

  it('FAILED_BREAKOUT_UP fades — SELL on red, not chase green', () => {
    expect(decideEntryFrom10sRegime(spikeDip, 'FAILED_BREAKOUT_UP')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(spikeRally, 'FAILED_BREAKOUT_UP')).toBeNull();
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
    expect(decideEntryFrom10sRegime(quiet, 'COMPRESSION')).toBeNull();
  });
});
