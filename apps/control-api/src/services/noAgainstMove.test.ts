import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  atLocalClimax,
  entryAgainstMarketMove,
  decideUnifiedEntry,
  emptySetup,
  minuteConfirmBar,
  buildStructure,
} from './marketSetup.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

/** Dump then green bounce tip — classic against-move BUY. */
function bounceTipMidDump(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 18; i++) bars.push(candle(4380, 4382, 4378, 4380));
  bars.push(candle(4380, 4381, 4370, 4371));
  bars.push(candle(4371, 4372, 4362, 4363));
  bars.push(candle(4363, 4364, 4355, 4356));
  bars.push(candle(4356, 4357, 4350, 4351));
  bars.push(candle(4351, 4358, 4350.5, 4357)); // bounce tip
  return bars;
}

describe('no entry against market move', () => {
  it('blocks BUY on bounce tip while sticky trend is DOWN', () => {
    const bars = bounceTipMidDump();
    expect(entryAgainstMarketMove('BUY', bars, 'CONTINUATION')).toBe(true);
  });

  it('atLocalClimax true on micro-rally parked at 8m high', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const o = 4350 + i * 0.4;
      bars.push(candle(o, o + 0.6, o - 0.2, o + 0.45));
    }
    // Park near the printed high
    const tip = bars[bars.length - 1]!.high;
    bars.push(candle(tip - 0.3, tip + 0.05, tip - 0.5, tip - 0.1));
    expect(atLocalClimax('BUY', bars)).toBe(true);
    expect(entryAgainstMarketMove('BUY', bars, 'CONTINUATION')).toBe(true);
  });

  it('decideUnifiedEntry refuses ARMED CONTINUATION BUY on dump bounce', () => {
    const bars = bounceTipMidDump();
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    const setup = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 2,
      swing_high: st.swing_high,
      swing_low: st.swing_low,
      reason: 'sticky CONTINUATION BUY',
    };
    const bar = minuteConfirmBar(bars)!;
    expect(
      decideUnifiedEntry({
        setup,
        structure: { ...st, at_tip: false, at_floor: false },
        bar,
        minutes: bars,
        livePx: bars[bars.length - 1]!.close,
        allowNoneImpulse: false,
      })
    ).toBeNull();
  });

  it('blocks CONTINUATION SELL parked at 8m floor', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const o = 4380 - i * 0.45;
      bars.push(candle(o, o + 0.25, o - 0.55, o - 0.4));
    }
    const floor = bars[bars.length - 1]!.low;
    bars.push(candle(floor + 0.4, floor + 0.6, floor - 0.05, floor + 0.15));
    expect(atLocalClimax('SELL', bars)).toBe(true);
    expect(entryAgainstMarketMove('SELL', bars, 'CONTINUATION')).toBe(true);
  });
});
