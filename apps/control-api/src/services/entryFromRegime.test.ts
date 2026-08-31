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
  it('waits on COMPRESSION; UNKNOWN/TRANSITION collapse to RANGE (need edge)', () => {
    expect(decideEntryFrom10sRegime(longDip, 'COMPRESSION', ctx)).toBeNull();
    expect(decideEntryFrom10sRegime(longDip, 'UNKNOWN', ctx)).toBeNull();
    expect(decideEntryFrom10sRegime(longRally, 'TRANSITION', ctx)).toBeNull();
  });

  it('TREND_UP dip-buys; rally follow only with bullish zones', () => {
    expect(decideEntryFrom10sRegime(longDip, 'TREND_UP', ctx)?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(longDip, 'TREND_UP', ctx)?.playbook).toBe('LONG');
    expect(decideEntryFrom10sRegime(longRally, 'TREND_UP', ctx)).toBeNull();
    const zonesUp = {
      ready: true,
      high: 2010,
      low: 1990,
      mid: 2000,
      span: 20,
      bias: 'ABOVE' as const,
      near_high: true,
      near_low: false,
      structure: 'TREND_UP' as const,
      bar_count: 40,
      updated_at: new Date().toISOString(),
      detail: 'test',
    };
    expect(decideEntryFrom10sRegime(longRally, 'TREND_UP', { ...ctx, zones: zonesUp })?.setup).toBe(
      'CONTINUATION'
    );
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

  it('RANGE FADE uses real minute zones when ready', () => {
    const zones = {
      ready: true,
      high: 2010,
      low: 2000,
      mid: 2005,
      span: 10,
      bias: 'BELOW' as const,
      near_high: false,
      near_low: true,
      structure: 'RANGE' as const,
      bar_count: 40,
      updated_at: new Date().toISOString(),
      detail: 'test',
    };
    const buy = decideEntryFrom10sRegime(longDip, 'RANGE', { ...ctx, zones });
    expect(buy?.direction).toBe('BUY');
    expect(buy?.reason).toMatch(/zone-low/);

    const noEdge = {
      ...zones,
      near_low: false,
      near_high: false,
      bias: 'INSIDE' as const,
    };
    expect(decideEntryFrom10sRegime(longDip, 'RANGE', { ...ctx, zones: noEdge })).toBeNull();
  });
});
