import { describe, expect, it } from 'vitest';
import { REVERSAL, TREND_ENTER } from './regimeBands.js';
import {
  decideReversalEntry,
  isViolentVFlip,
  reversalBiasFromBars,
  reversalStructureAllows,
} from './reversalPlaybook.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(
  open: number,
  close: number,
  extra?: Partial<TenSecBar>
): TenSecBar {
  const high = Math.max(open, close) + (extra?.high != null ? 0 : Math.abs(close - open) * 0.1);
  const low = Math.min(open, close) - (extra?.low != null ? 0 : Math.abs(close - open) * 0.1);
  return {
    open_time_ms: extra?.open_time_ms ?? 1_700_000_000_000,
    open,
    high: extra?.high ?? high,
    low: extra?.low ?? low,
    close,
    ticks: 8,
  };
}

/** ~REVERSAL body on Gold ~4100 */
function violentDown(mid = 4100): TenSecBar {
  const body = mid * (REVERSAL + 0.0002);
  return bar(mid, mid - body);
}

function violentUp(mid = 4100): TenSecBar {
  const body = mid * (REVERSAL + 0.0002);
  return bar(mid, mid + body);
}

/** Quiet confirm — moving but not spike */
function softDown(mid = 4100): TenSecBar {
  const body = mid * 0.00015; // ~MOVE+, below TREND_ENTER spike
  return bar(mid, mid - body);
}

function softUp(mid = 4100): TenSecBar {
  const body = mid * 0.00015;
  return bar(mid, mid + body);
}

describe('reversalPlaybook — V-spike bias', () => {
  it('bias SELL after violent red flip bar', () => {
    expect(reversalBiasFromBars([violentDown()])).toBe('SELL');
  });

  it('bias BUY after violent green flip bar', () => {
    expect(reversalBiasFromBars([violentUp()])).toBe('BUY');
  });

  it('detects two-bar V-flip upThenDown / downThenUp', () => {
    const priorUp = bar(4100, 4100 + 4100 * (TREND_ENTER + 0.0001));
    const flipDown = violentDown(4100);
    expect(isViolentVFlip(priorUp, flipDown, 0.0001)).toBe(true);
    // Same bodies but fat avgRange → not a real expand tip
    expect(isViolentVFlip(priorUp, flipDown, 0.05)).toBe(false);

    const priorDown = bar(4100, 4100 - 4100 * (TREND_ENTER + 0.0001));
    const flipUp = violentUp(4100);
    expect(isViolentVFlip(priorDown, flipUp, 0.0001)).toBe(true);
  });
});

describe('reversalPlaybook — entry confirm (no spike chase)', () => {
  it('does not enter on the violent spike itself', () => {
    const impulse = violentDown();
    expect(decideReversalEntry(impulse, [impulse], 0.6)).toBeNull();
  });

  it('SELL only after quieter confirm in upper half', () => {
    const impulse = violentDown(4120);
    const confirm = softDown(4115);
    const hit = decideReversalEntry(confirm, [impulse], 0.7);
    expect(hit?.direction).toBe('SELL');
    expect(hit?.setup).toBe('REVERSAL');
    expect(hit?.reason).toMatch(/SELL confirm/);
  });

  it('blocks SELL confirm too far in LO flush', () => {
    const impulse = violentDown(4120);
    const confirm = softDown(4110);
    expect(decideReversalEntry(confirm, [impulse], 0.2)).toBeNull();
  });

  it('BUY only after quieter confirm — never opposite of bias', () => {
    const impulse = violentUp(4100);
    const wrong = softDown(4105);
    expect(decideReversalEntry(wrong, [impulse], 0.4)).toBeNull();
    const confirm = softUp(4105);
    expect(decideReversalEntry(confirm, [impulse], 0.35)?.direction).toBe('BUY');
  });

  it('structure allows only bias side', () => {
    expect(reversalStructureAllows('SELL', 'SELL', 0.6, 'DOWN').ok).toBe(true);
    expect(reversalStructureAllows('BUY', 'SELL', 0.6, 'DOWN').ok).toBe(false);
  });
});
