import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import {
  buildStructure,
  decideEntryFromImpulseCandle,
  decideEntryFromSetup,
  decideUnifiedEntry,
  emptySetup,
  flowFlipAtExtreme,
  liveFlow,
  marketTrend,
  priceFlowBias,
  updateSetupSticky,
} from './marketSetup.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

function bar10(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: 0, open: o, high: h, low: l, close: c, ticks: 5 };
}

/** Screenshot class: dump to fresh low then 3 green reclaim candles. */
function dumpThenBuyLeg(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 14; i++) bars.push(candle(4376, 4378, 4375, 4377));
  bars.push(candle(4377, 4380.2, 4376.5, 4379.5));
  bars.push(candle(4379.5, 4380.0, 4376.0, 4376.5));
  bars.push(candle(4376.5, 4377.0, 4374.0, 4374.5));
  bars.push(candle(4374.5, 4375.0, 4372.2, 4372.5));
  bars.push(candle(4372.5, 4373.4, 4372.3, 4373.2));
  bars.push(candle(4373.2, 4374.0, 4373.0, 4373.8));
  bars.push(candle(4373.8, 4374.5, 4373.6, 4374.3));
  return bars;
}

describe('flip-first both sides — live Aug31/unified path', () => {
  it('dump → BUY leg: flow UP, no late SELL (impulse + unified)', () => {
    const bars = dumpThenBuyLeg();
    const b = bar10(4374, 4374.5, 4373.7, 4374.3);
    expect(marketTrend(bars)).toBe('DOWN');
    expect(flowFlipAtExtreme(bars)).toBe('UP');
    expect(priceFlowBias(bars)).toBe('UP');
    expect(liveFlow(bars)).toBe('UP');
    expect(decideEntryFromImpulseCandle(b, bars)?.direction).toBe('BUY');
    expect(decideEntryFromImpulseCandle(b, bars)?.direction).not.toBe('SELL');

    const st = buildStructure({ minutes: bars, mid: 4374.3 });
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar: b,
        minutes: bars,
        livePx: 4374.3,
      })?.direction
    ).toBe('BUY');

    // Sticky ARMED SELL must refuse entry while flow UP
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
    expect(decideEntryFromSetup(armedSell, b, bars, 4374.3)).toBeNull();
  });

  it('rally → SELL leg: flow DOWN, no late BUY (mid-reject, not finished floor)', () => {
    // Stop mid-reject — 2 reds off high, still extending (not moveAlreadyFinished floor)
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) bars.push(candle(4370, 4372, 4369, 4371));
    bars.push(candle(4371, 4372.0, 4368.5, 4369.0));
    bars.push(candle(4369.0, 4373.0, 4368.8, 4372.5));
    bars.push(candle(4372.5, 4376.0, 4372.0, 4375.5));
    bars.push(candle(4375.5, 4378.2, 4375.0, 4377.8)); // fresh high
    bars.push(candle(4377.8, 4378.0, 4375.8, 4376.0)); // red
    bars.push(candle(4376.0, 4376.2, 4374.5, 4374.8)); // red — still mid reject
    const b = bar10(4376.0, 4376.2, 4374.5, 4374.8);
    expect(marketTrend(bars)).toBe('UP');
    expect(flowFlipAtExtreme(bars)).toBe('DOWN');
    expect(priceFlowBias(bars)).toBe('DOWN');
    expect(liveFlow(bars)).toBe('DOWN');
    expect(decideEntryFromImpulseCandle(b, bars)?.direction).toBe('SELL');
    expect(decideEntryFromImpulseCandle(b, bars)?.direction).not.toBe('BUY');

    const st = buildStructure({ minutes: bars, mid: 4374.8 });
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar: b,
        minutes: bars,
        livePx: 4374.8,
      })?.direction
    ).toBe('SELL');

    const armedBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: st.swing_high,
      swing_low: st.swing_low,
    };
    expect(decideEntryFromSetup(armedBuy, b, bars, 4374.8)).toBeNull();
  });

  it('sticky setup uses flowFlip — not raw marketTrend bounceInDump', () => {
    const bars = dumpThenBuyLeg();
    // Stronger UP impulse so rawSetup IMPULSE branch can see it
    bars.push(candle(4374.3, 4376.5, 4374.2, 4376.2));
    bars.push(candle(4376.2, 4377.8, 4376.0, 4377.5));
    const st = buildStructure({ minutes: bars, mid: 4377.5 });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    setup = updateSetupSticky(setup, st, bars);
    // After real reclaim, must not stay trapped as SELL-only by sticky 20m DOWN
    expect(priceFlowBias(bars)).toBe('UP');
    if (setup.side === 'SELL' && setup.status === 'ARMED') {
      throw new Error(`sticky still ARMED SELL after UP flip: ${setup.reason}`);
    }
  });
});

describe('flip-first vs Aug13 legacy entryFromRegime', () => {
  it('legacy TREND_DOWN sells the reclaim rally — dangerous without flowFlip (NOT LIVE)', () => {
    const bars = dumpThenBuyLeg();
    expect(priceFlowBias(bars)).toBe('UP');
    // Stronger 10s-style body: Aug13 TREND_DOWN still rally-sells into the BUY leg
    const b = bar10(4373.0, 4374.8, 4372.9, 4374.5);
    const legacy = decideEntryFrom10sRegime(b, 'TREND_DOWN', { regimeAgeBars: 3 });
    expect(legacy?.direction).toBe('SELL');
    expect(legacy?.setup).toBe('PULLBACK');
  });

  it('live unified blocks the Aug13 late SELL on the same reclaim bar', () => {
    const bars = dumpThenBuyLeg();
    const b = bar10(4373.0, 4374.8, 4372.9, 4374.5);
    const st = buildStructure({ minutes: bars, mid: 4374.5 });
    const live = decideUnifiedEntry({
      setup: emptySetup(),
      structure: st,
      bar: b,
      minutes: bars,
      livePx: 4374.5,
    });
    expect(live?.direction).not.toBe('SELL');
    expect(live?.direction).toBe('BUY');
  });
});
