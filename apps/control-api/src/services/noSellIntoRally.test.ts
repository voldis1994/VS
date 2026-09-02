import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideEntryFromImpulseCandle,
  decideEntryFromSetup,
  decideUnifiedEntry,
  emptySetup,
  entryFightsStickyTrend,
  marketTrend,
  moveAlreadyFinished,
} from './marketSetup.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}
function bar10(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: 0, open: o, high: h, low: l, close: c, ticks: 5 };
}

/** Winning BUY then mid-rally — Gold 20:28 win → 20:29 SELL −£0.13 class */
function rallyAfterWin(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 12; i++) bars.push(candle(4373, 4374, 4372, 4373.5));
  bars.push(candle(4373.5, 4376, 4373.2, 4375.8));
  bars.push(candle(4375.8, 4378, 4375.5, 4377.8));
  bars.push(candle(4377.8, 4380, 4377.5, 4379.5));
  bars.push(candle(4379.5, 4381.5, 4379.2, 4381.2));
  bars.push(candle(4381.2, 4381.4, 4380.2, 4380.5)); // tiny red pullback
  return bars;
}

describe('no SELL into rally / no tip BUY (20:29–20:34 class)', () => {
  it('blocks SELL while marketTrend still UP without V-flip DOWN', () => {
    const bars = rallyAfterWin();
    expect(marketTrend(bars)).toBe('UP');
    expect(entryFightsStickyTrend('SELL', bars)).toBe(true);
    const b = bar10(4380.5, 4381.2, 4380.2, 4381.12);
    expect(decideEntryFromImpulseCandle(b, bars)?.direction).not.toBe('SELL');
    const st = buildStructure({ minutes: bars, mid: 4381.12 });
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar: b,
        minutes: bars,
        livePx: 4381.12,
      })?.direction
    ).not.toBe('SELL');
    const armedSell = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'SELL' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: st.swing_high,
      swing_low: st.swing_low,
    };
    expect(decideEntryFromSetup(armedSell, b, bars, 4381.12)).toBeNull();
  });

  it('blocks tip-chase BUY after long UP run near window high', () => {
    const bars = rallyAfterWin();
    bars.push(candle(4380.5, 4383.2, 4380.4, 4383.0));
    bars.push(candle(4383.0, 4383.5, 4382.5, 4382.95));
    expect(moveAlreadyFinished('BUY', bars, 4382.95)).toBe(true);
    const b = bar10(4383.0, 4383.5, 4382.5, 4382.95);
    expect(decideEntryFromImpulseCandle(b, bars)?.direction).not.toBe('BUY');
    const st = buildStructure({ minutes: bars, mid: 4382.95 });
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar: b,
        minutes: bars,
        livePx: 4382.95,
      })?.direction
    ).not.toBe('BUY');
  });
});
