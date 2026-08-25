import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  decideEntryFrom10sRegime,
  explainNoEntry,
  lateChaseAppliesToSetup,
  recentImpulse,
  signalBarTooLate,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0): TenSecBar {
  const high = Math.max(open, close) + 2;
  const low = Math.min(open, close) - 1;
  return { open_time_ms: i * 300_000, open, high, low, close, ticks: 12 };
}

/** Soft ~3pt bodies — enough for regime-led timing, below old 4–6pt gate. */
const softDip = bar(4645, 4642);
const softRally = bar(4642, 4645);

const upImpulse: TenSecBar[] = [
  bar(4600, 4608, 0),
  bar(4608, 4618, 1),
  bar(4618, 4628, 2),
];

const downImpulse: TenSecBar[] = [
  bar(4660, 4652, 0),
  bar(4652, 4648, 1),
  bar(4648, 4643, 2),
];

describe('regime-led 5m entry', () => {
  it('skips chop: RANGE / UNKNOWN / FADE / REVERSAL', () => {
    expect(decideEntryFrom10sRegime(softDip, 'UNKNOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(softRally, 'COMPRESSION')).toBeNull();
    expect(decideEntryFrom10sRegime(softDip, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(softDip, 'FAILED_BREAKOUT_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(softRally, 'REVERSAL_CANDIDATE')).toBeNull();
  });

  it('TREND_DOWN sells soft red continuation — no 4–6pt wait', () => {
    const sig = decideEntryFrom10sRegime(softDip, 'TREND_DOWN');
    expect(sig?.direction).toBe('SELL');
    expect(sig?.setup).toBe('CONTINUATION');
  });

  it('TREND_DOWN rally-sells soft green pullback', () => {
    expect(decideEntryFrom10sRegime(softRally, 'TREND_DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(softRally, 'TREND_DOWN')?.setup).toBe('PULLBACK');
  });

  it('TREND_UP buys soft green continuation and red dip', () => {
    expect(decideEntryFrom10sRegime(softRally, 'TREND_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(softDip, 'TREND_UP')?.direction).toBe('BUY');
  });

  it('EXPANSION DOWN follows soft red with impulse', () => {
    expect(decideEntryFrom10sRegime(softDip, 'EXPANSION', downImpulse)?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(softRally, 'EXPANSION', downImpulse)?.direction).toBe('SELL');
  });

  it('EXPANSION UP never fades with SELL', () => {
    expect(decideEntryFrom10sRegime(softDip, 'EXPANSION', upImpulse)?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(softRally, 'EXPANSION', upImpulse)?.direction).toBe('BUY');
  });

  it('EXPANSION without clear flow does not guess green=BUY', () => {
    expect(decideEntryFrom10sRegime(softRally, 'EXPANSION', [])).toBeNull();
  });

  it('BREAKOUT follows soft live with regime', () => {
    expect(decideEntryFrom10sRegime(softRally, 'BREAKOUT_UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(softDip, 'BREAKOUT_DOWN')?.direction).toBe('SELL');
  });

  it('rejects late exhausted 5m bar', () => {
    const late = bar(4600, 4625);
    expect(signalBarTooLate(late)).toBe(true);
    expect(decideEntryFrom10sRegime(late, 'BREAKOUT_UP')).toBeNull();
  });

  it('flat doji is not soft live', () => {
    const quiet: TenSecBar = {
      open_time_ms: 0,
      open: 4643,
      high: 4643.4,
      low: 4642.8,
      close: 4643.1,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(quiet, 'TREND_DOWN')).toBeNull();
    expect(explainNoEntry(quiet, 'TREND_DOWN')).toMatch(/soft live/);
  });

  it('late-chase gate skips TREND (thesis is the move)', () => {
    expect(lateChaseAppliesToSetup('CONTINUATION', 'TREND_DOWN')).toBe(false);
    expect(lateChaseAppliesToSetup('PULLBACK', 'TREND_UP')).toBe(false);
    expect(lateChaseAppliesToSetup('BREAKOUT', 'BREAKOUT_DOWN')).toBe(true);
    expect(lateChaseAppliesToSetup('CONTINUATION', 'EXPANSION')).toBe(true);
  });
});

describe('no SELL into fresh buy impulse', () => {
  it('detects strong UP impulse', () => {
    expect(recentImpulse(upImpulse).dir).toBe('UP');
  });

  it('blocks SELL after buy spike', () => {
    expect(allowEntryAgainstImpulse('SELL', upImpulse).ok).toBe(false);
    expect(allowEntryAgainstImpulse('BUY', upImpulse).ok).toBe(true);
  });

  it('blocks BUY under swing-high dump (the mīnus long case)', () => {
    // Rally then dump under the high — green bounce must NOT buy
    const dump: TenSecBar[] = [
      bar(4650, 4655, 0),
      bar(4655, 4660, 1),
      bar(4660, 4652, 2),
      bar(4652, 4648, 3),
      bar(4648, 4645, 4),
      bar(4645, 4642, 5),
    ];
    const bounce = bar(4642, 4644.5, 6);
    expect(allowEntryAgainstImpulse('BUY', dump, bounce).ok).toBe(false);
    expect(decideEntryFrom10sRegime(bounce, 'TREND_UP', dump)).toBeNull();
    expect(decideEntryFrom10sRegime(bounce, 'EXPANSION', dump)?.direction).toBe('SELL');
  });

  it('blocks BUY into short dump even with live green tick', () => {
    const dump: TenSecBar[] = [
      bar(4660, 4652, 0),
      bar(4652, 4648, 1),
      bar(4648, 4643, 2),
      bar(4643, 4640, 3),
    ];
    const liveGreen = bar(4640, 4642.5, 4);
    expect(allowEntryAgainstImpulse('BUY', dump, liveGreen).ok).toBe(false);
    expect(allowEntryAgainstImpulse('SELL', dump, liveGreen).ok).toBe(true);
  });
});
