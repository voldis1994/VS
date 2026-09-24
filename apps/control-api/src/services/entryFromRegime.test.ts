import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { isSpike10s, type TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, pad = 0.15): TenSecBar {
  const high = Math.max(open, close) + pad;
  const low = Math.min(open, close) - pad * 0.5;
  return { open_time_ms: 0, open, high, low, close, ticks: 12 };
}

/** ~0.2% — SPIKE (must NOT chase in RANGE/COMPRESSION) */
const spikeDip = bar(2000, 1996, 0.8);
const spikeRally = bar(2000, 2004, 0.8);
/** ~0.025% — MOVING micro (still fade in RANGE/COMPRESSION) */
const microDip = bar(2000, 1999.5, 0.12);
const microRally = bar(2000, 2000.5, 0.12);

describe('10s + 14-regime suitable entry', () => {
  it('COMPRESSION/TRANSITION OPEN fade on micro move', () => {
    expect(decideEntryFrom10sRegime(microDip, 'COMPRESSION')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(microRally, 'COMPRESSION')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(microDip, 'TRANSITION')?.direction).toBe('BUY');
  });

  it('micro MOVE in RANGE fades; COMPRESSION also fades (open book)', () => {
    expect(isSpike10s(microDip)).toBe(false);
    expect(decideEntryFrom10sRegime(microDip, 'RANGE')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(microRally, 'RANGE')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(microDip, 'COMPRESSION')?.direction).toBe('BUY');
  });

  it('waits only in UNKNOWN — TRANSITION/COMPRESSION open', () => {
    expect(decideEntryFrom10sRegime(spikeDip, 'UNKNOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(microRally, 'TRANSITION')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(microDip, 'COMPRESSION')?.direction).toBe('BUY');
  });

  it('TREND_UP dip-buys pullback only — never chase rally / never sells', () => {
    expect(decideEntryFrom10sRegime(spikeDip, 'TREND_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(spikeDip, 'TREND_UP')?.setup).toBe('PULLBACK');
    expect(decideEntryFrom10sRegime(spikeRally, 'TREND_UP')).toBeNull();
  });

  it('TREND_DOWN rally-sells pullback only — never chase dip / never buys', () => {
    expect(decideEntryFrom10sRegime(spikeRally, 'TREND_DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(spikeDip, 'TREND_DOWN')).toBeNull();
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

  it('FAILED_BREAKOUT_UP fades — SELL, not chase', () => {
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
