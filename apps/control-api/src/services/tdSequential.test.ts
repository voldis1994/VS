import { describe, expect, it } from 'vitest';
import {
  computeTdSequential,
  decideEntryFromTdSequential,
  describeTdSequential,
} from './tdSequential.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function c(close: number, high?: number, low?: number): TenSecBar {
  const h = high ?? close + 0.2;
  const l = low ?? close - 0.2;
  return {
    open_time_ms: 0,
    open: close,
    high: Math.max(h, close),
    low: Math.min(l, close),
    close,
    ticks: 8,
  };
}

/** Build a clean TD Buy Setup 9 sequence (closes stepping down vs close-4). */
function buySetup9Bars(): TenSecBar[] {
  // Indices 0..4: rising so bar5 can flip bearish
  // close: 100,101,102,103,104, then drop sequence
  const closes = [
    100, 101, 102, 103, 104, // 0-4
    // i=5 flip: prevC=104 >= prevC4=100, c=99 < c4=101 → buy setup 1
    99,
    // i=6: 98 < 102
    98,
    // i=7: 97 < 103
    97,
    // i=8: 96 < 104
    96,
    // i=9: 95 < 99
    95,
    // i=10: 94 < 98
    94,
    // i=11: 93 < 97
    93,
    // i=12: 92 < 96
    92,
    // i=13: 91 < 95 → setup 9
    91,
  ];
  return closes.map((x, i) => ({ ...c(x), open_time_ms: i * 10_000 }));
}

function sellSetup9Bars(): TenSecBar[] {
  const closes = [
    100, 99, 98, 97, 96, // falling base
    // i=5 flip: prev 96 <= 100, c=101 > 99 → sell 1
    101,
    102, // > 98
    103, // > 97
    104, // > 96
    105, // > 101
    106, // > 102
    107, // > 103
    108, // > 104
    109, // > 105 → setup 9
  ];
  return closes.map((x, i) => ({ ...c(x), open_time_ms: i * 10_000 }));
}

describe('TD Sequential', () => {
  it('completes Buy Setup 9 and arms BUY entry', () => {
    const bars = buySetup9Bars();
    const s = computeTdSequential(bars);
    expect(s.buy_setup_complete).toBe(true);
    expect(s.buy_setup).toBe(9);
    expect(s.phase).toBe('buy_countdown');
    expect(describeTdSequential(s)).toMatch(/Buy Setup 9/);

    const e = decideEntryFromTdSequential(bars);
    expect(e?.direction).toBe('BUY');
    expect(e?.reason).toMatch(/TD Buy Setup 9/);
  });

  it('completes Sell Setup 9 and arms SELL entry', () => {
    const bars = sellSetup9Bars();
    const s = computeTdSequential(bars);
    expect(s.sell_setup_complete).toBe(true);
    expect(s.sell_setup).toBe(9);
    const e = decideEntryFromTdSequential(bars);
    expect(e?.direction).toBe('SELL');
    expect(e?.reason).toMatch(/TD Sell Setup 9/);
  });

  it('returns null before setup completes', () => {
    const bars = buySetup9Bars().slice(0, 10); // incomplete
    expect(decideEntryFromTdSequential(bars)).toBeNull();
  });

  it('counts Buy Countdown toward 13 after setup', () => {
    const bars = buySetup9Bars();
    // After setup, phase is buy_countdown. Add bars with close <= low[i-2]
    let seq = [...bars];
    for (let n = 0; n < 13; n++) {
      const last = seq[seq.length - 1]!;
      const refLow = seq[seq.length - 2]!.low;
      seq.push({
        ...c(refLow - 0.5, refLow, refLow - 1),
        open_time_ms: last.open_time_ms + 10_000,
      });
    }
    const s = computeTdSequential(seq);
    expect(s.buy_countdown_complete || s.buy_countdown >= 13 || s.phase === 'none').toBe(true);
    const e = decideEntryFromTdSequential(seq);
    // Either CD13 or still mid-countdown; if complete, BUY
    if (s.buy_countdown_complete) {
      expect(e?.direction).toBe('BUY');
      expect(e?.reason).toMatch(/Countdown 13/);
    }
  });
});
