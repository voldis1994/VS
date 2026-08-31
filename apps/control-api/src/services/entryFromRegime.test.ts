import { describe, expect, it } from 'vitest';
import {
  decideEntryFrom10sRegime,
  decideMoveEntry,
  decidePriceMove,
  decideTickMove,
  labelPlaybookForMove,
} from './entryFromRegime.js';
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

  it('TREND_UP dip-buys and follows rally', () => {
    expect(decideEntryFrom10sRegime(longDip, 'TREND_UP', ctx)?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(longDip, 'TREND_UP', ctx)?.playbook).toBe('LONG');
    expect(decideEntryFrom10sRegime(longRally, 'TREND_UP', ctx)?.setup).toBe('CONTINUATION');
  });

  it('TREND_DOWN rally-sells and dump-follows', () => {
    expect(decideEntryFrom10sRegime(longRally, 'TREND_DOWN', ctx)?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(longDip, 'TREND_DOWN', ctx)?.direction).toBe('SELL');
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

  it('MOVE entry opens SELL on dump and BUY on rally', () => {
    expect(decideMoveEntry(longDip)?.direction).toBe('SELL');
    expect(decideMoveEntry(longRally)?.direction).toBe('BUY');
    expect(decideMoveEntry(quiet)).toBeNull();
  });

  it('price move opens SELL when mid dumps vs recent high', () => {
    expect(decidePriceMove(4454, 4460, 4448)?.direction).toBe('SELL');
    expect(decidePriceMove(4462, 4460, 4448)?.direction).toBe('BUY');
    expect(decidePriceMove(4455, 4455.2, 4454.8)).toBeNull();
  });

  it('tick move helper still exists but needs a larger print', () => {
    expect(decideTickMove(4454, 4456)?.direction).toBe('SELL');
    expect(decideTickMove(4457, 4455)?.direction).toBe('BUY');
    expect(decideTickMove(4455, 4455.2)).toBeNull();
  });

  it('labelPlaybookForMove prefers zone playbook', () => {
    expect(labelPlaybookForMove('SELL', 'RANGE', 'LONG').playbook).toBe('LONG');
    expect(labelPlaybookForMove('SELL', 'FAILED_BREAKOUT_DOWN', 'SCALP').playbook).toBe('SCALP');
    expect(labelPlaybookForMove('BUY', 'RANGE', 'FADE').playbook).toBe('FADE');
  });

  it('FAILED_BREAKOUT_DOWN fades bounce as FADE BUY (not scalp chase)', () => {
    expect(decideEntryFrom10sRegime(longRally, 'FAILED_BREAKOUT_DOWN', ctx)?.direction).toBe(
      'BUY'
    );
    expect(decideEntryFrom10sRegime(longRally, 'FAILED_BREAKOUT_DOWN', ctx)?.playbook).toBe(
      'FADE'
    );
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
