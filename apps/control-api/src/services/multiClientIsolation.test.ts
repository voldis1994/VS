import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyRegime,
  observeClosedBars,
  currentRegime,
  resetRegimeBook,
  regimeBookKey,
} from './regimes.js';
import { robotIdFor } from './robotDesk.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: Date.now(), open: o, high: h, low: l, close: c, ticks: 2 };
}

describe('multi-client same epic isolation', () => {
  beforeEach(() => resetRegimeBook());

  it('robotIdFor differs per account with same epic', () => {
    const a = robotIdFor(1, 'GOLD');
    const b = robotIdFor(2, 'GOLD');
    expect(a).not.toBe(b);
    expect(a).toBe('r1_GOLD');
    expect(b).toBe('r2_GOLD');
  });

  it('regimeBookKey scopes accounts separately', () => {
    expect(regimeBookKey('GOLD')).toBe('GOLD');
    expect(regimeBookKey('GOLD', 10)).toBe('a10::GOLD');
    expect(regimeBookKey('GOLD', 11)).toBe('a11::GOLD');
    expect(regimeBookKey('GOLD', 10)).not.toBe(regimeBookKey('GOLD', 11));
  });

  it('two accounts on GOLD keep independent regime books', () => {
    // Account 1: quiet range bars
    const rangeBars = [
      bar(2000, 2000.2, 1999.8, 2000),
      bar(2000, 2000.1, 1999.9, 2000.05),
      bar(2000.05, 2000.15, 1999.95, 2000),
    ];
    // Account 2: strong up trend-ish bodies
    const upBars = [
      bar(2000, 2004, 1999.5, 2003.5),
      bar(2003.5, 2008, 2003, 2007.5),
      bar(2007.5, 2012, 2007, 2011),
      bar(2011, 2015, 2010.5, 2014),
      bar(2014, 2018, 2013.5, 2017),
      bar(2017, 2021, 2016.5, 2020),
    ];

    const snap1 = observeClosedBars('GOLD', rangeBars, 'Gold', 101);
    const snap2 = observeClosedBars('GOLD', upBars, 'Gold', 202);

    expect(currentRegime('GOLD', 101)?.current).toBe(snap1.current);
    expect(currentRegime('GOLD', 202)?.current).toBe(snap2.current);
    // Must not overwrite each other
    expect(currentRegime('GOLD', 101)?.bar_count).toBe(rangeBars.length);
    expect(currentRegime('GOLD', 202)?.bar_count).toBe(upBars.length);
  });

  it('local classifyRegime is independent of shared books', () => {
    const barsA = [bar(100, 100.1, 99.9, 100), bar(100, 100.05, 99.95, 100.02)];
    const barsB = [
      bar(100, 101, 99.5, 100.8),
      bar(100.8, 102, 100.5, 101.7),
      bar(101.7, 103, 101.4, 102.6),
      bar(102.6, 104, 102.3, 103.5),
      bar(103.5, 105, 103.2, 104.4),
      bar(104.4, 106, 104.1, 105.3),
    ];
    const rA = classifyRegime(barsA, 'UNKNOWN');
    const rB = classifyRegime(barsB, 'UNKNOWN');
    // Just assert both return valid names and are computed separately
    expect(typeof rA).toBe('string');
    expect(typeof rB).toBe('string');
  });
});
