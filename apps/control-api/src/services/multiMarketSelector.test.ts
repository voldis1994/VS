import { describe, expect, it } from 'vitest';
import { scoreMarketSetup } from './multiMarketSelector.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + 0.4,
    low: Math.min(open, close) - 0.2,
    close,
    ticks: 10,
  };
}

describe('scoreMarketSetup', () => {
  it('scores fresh BREAKOUT higher than empty', () => {
    const fresh = bar(4500, 4501.5); // ~0.033%
    const a = scoreMarketSetup({
      entry: {
        direction: 'BUY',
        setup: 'BREAKOUT',
        reason: 'BREAKOUT_UP follow',
      },
      regime: 'BREAKOUT_UP',
      bar: fresh,
    });
    expect(a.score).toBeGreaterThanOrEqual(78);
    expect(scoreMarketSetup({ entry: null, regime: 'COMPRESSION', bar: fresh }).score).toBe(0);
  });

  it('penalizes spent chase bars', () => {
    const spent = bar(4500, 4504); // ~0.089%
    const a = scoreMarketSetup({
      entry: {
        direction: 'BUY',
        setup: 'BREAKOUT',
        reason: 'BREAKOUT_UP follow',
      },
      regime: 'BREAKOUT_UP',
      bar: spent,
    });
    expect(a.score).toBeLessThan(78);
  });

  it('ranks TD Countdown 13 above BREAKOUT on same body', () => {
    const b = bar(4500, 4501.2);
    const td = scoreMarketSetup({
      entry: {
        direction: 'BUY',
        setup: 'REVERSAL',
        reason: 'TD Buy Countdown 13 · 10s O=4500.00 C=4501.20',
      },
      regime: 'COMPRESSION',
      bar: b,
    });
    const bo = scoreMarketSetup({
      entry: { direction: 'BUY', setup: 'BREAKOUT', reason: 'BO' },
      regime: 'BREAKOUT_UP',
      bar: b,
    });
    expect(td.score).toBeGreaterThan(bo.score);
  });
});
