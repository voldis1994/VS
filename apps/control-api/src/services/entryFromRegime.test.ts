import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  decideEntryFrom10sRegime,
  lateChaseAppliesToSetup,
  marketDirection,
  recentImpulse,
  shortNetMove,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0): TenSecBar {
  const high = Math.max(open, close) + 2;
  const low = Math.min(open, close) - 1;
  return { open_time_ms: i * 300_000, open, high, low, close, ticks: 12 };
}

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

describe('one-rule entry', () => {
  it('skips chop regimes', () => {
    expect(decideEntryFrom10sRegime(softDip, 'UNKNOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(softDip, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(softDip, 'COMPRESSION')).toBeNull();
  });

  it('TREND_DOWN + dump → SELL (not BUY)', () => {
    const sig = decideEntryFrom10sRegime(softDip, 'TREND_DOWN', downImpulse);
    expect(sig?.direction).toBe('SELL');
    expect(marketDirection('TREND_UP', downImpulse, softDip)).toBe('SELL'); // short wins
  });

  it('dump under highs never BUYs on green bounce', () => {
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
    expect(decideEntryFrom10sRegime(bounce, 'TREND_UP', dump)?.direction).toBe('SELL');
  });

  it('clear UP short → BUY with market', () => {
    expect(decideEntryFrom10sRegime(softRally, 'EXPANSION', upImpulse)?.direction).toBe('BUY');
    expect(allowEntryAgainstImpulse('BUY', upImpulse, softRally).ok).toBe(true);
    expect(allowEntryAgainstImpulse('SELL', upImpulse, softRally).ok).toBe(false);
  });

  it('regime bias when short is flat', () => {
    const flat: TenSecBar[] = [bar(4640, 4640.3, 0), bar(4640.3, 4640.1, 1)];
    expect(marketDirection('TREND_DOWN', flat, softDip)).toBe('SELL');
    expect(decideEntryFrom10sRegime(softDip, 'TREND_DOWN', flat)?.direction).toBe('SELL');
  });

  it('late-chase gate is off', () => {
    expect(lateChaseAppliesToSetup('BREAKOUT', 'BREAKOUT_DOWN')).toBe(false);
    expect(lateChaseAppliesToSetup('CONTINUATION', 'EXPANSION')).toBe(false);
  });

  it('detects impulse', () => {
    expect(recentImpulse(upImpulse).dir).toBe('UP');
    expect(shortNetMove(downImpulse).dir).toBe('DOWN');
  });
});
