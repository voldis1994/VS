import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideUnifiedEntry,
  emptySetup,
  entryCandleConfirmDeny,
  isSpikeCandle,
  minuteConfirmBar,
} from './marketSetup.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

describe('closed candle confirm — not spike (old rule)', () => {
  it('minuteConfirmBar does not overlay live mid by default', () => {
    const bars = [candle(100, 101, 99, 100.5)];
    const b = minuteConfirmBar(bars, 105);
    expect(b?.close).toBe(100.5);
    const live = minuteConfirmBar(bars, 105, { overlayLive: true });
    expect(live?.close).toBe(105);
  });

  it('flags impulse spike vs quiet prior bars', () => {
    const prior: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) prior.push(candle(4380, 4380.4, 4379.7, 4380.1));
    const spike = candle(4380.1, 4384.5, 4380.0, 4384.2); // ~4pt body
    expect(isSpikeCandle(spike, prior)).toBe(true);
    const normal = candle(4380.1, 4380.6, 4379.9, 4380.4);
    expect(isSpikeCandle(normal, prior)).toBe(false);
  });

  it('denies SELL on green candle and on the spike itself', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) bars.push(candle(4375, 4375.5, 4374.6, 4375.2));
    bars.push(candle(4375.2, 4381.5, 4375.0, 4381.2)); // UP spike
    expect(entryCandleConfirmDeny('SELL', bars)).toMatch(/spike|green/i);
  });

  it('allows SELL only after red confirm closes below UP spike', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) bars.push(candle(4375, 4375.5, 4374.6, 4375.2));
    bars.push(candle(4375.2, 4381.5, 4375.0, 4381.2)); // UP spike
    bars.push(candle(4381.2, 4381.3, 4380.2, 4380.4)); // first red
    bars.push(candle(4380.4, 4380.5, 4379.5, 4379.8)); // 2nd red confirm below spike close
    expect(entryCandleConfirmDeny('SELL', bars)).toBeNull();
  });

  it('denies SELL on single red after green (need 2-red momentum)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) bars.push(candle(4375, 4375.5, 4374.6, 4375.2));
    bars.push(candle(4375.2, 4376.0, 4375.0, 4375.8)); // green
    bars.push(candle(4375.8, 4375.9, 4374.5, 4374.7)); // only one red
    expect(entryCandleConfirmDeny('SELL', bars)).toMatch(/2 red|momentum/i);
  });

  it('denies SELL if after UP spike the next bar is still green (no confirm)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) bars.push(candle(4375, 4375.5, 4374.6, 4375.2));
    bars.push(candle(4375.2, 4381.5, 4375.0, 4381.2));
    bars.push(candle(4381.2, 4382.0, 4380.9, 4381.7)); // still green — no SELL
    expect(entryCandleConfirmDeny('SELL', bars)).toMatch(/red|green|spike/i);
  });

  it('unified entry waits — no SELL on spike bar (20:29 class)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 12; i++) bars.push(candle(4373, 4374, 4372, 4373.5));
    bars.push(candle(4373.5, 4378, 4373.2, 4377.5));
    bars.push(candle(4377.5, 4381.5, 4377.2, 4381.2)); // spike into 4381
    const st = buildStructure({ minutes: bars, mid: 4381.2 });
    const bar = minuteConfirmBar(bars)!;
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar,
        minutes: bars,
        livePx: 4381.2,
      })
    ).toBeNull();
  });

  it('soft: one green NOT enough without proven rally — strict still wants 2-green', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) bars.push(candle(4375, 4375.5, 4374.6, 4375.2));
    bars.push(candle(4375.2, 4375.9, 4374.8, 4374.9)); // red
    bars.push(candle(4374.9, 4376.2, 4374.8, 4376.0)); // one green
    expect(entryCandleConfirmDeny('BUY', bars)).toMatch(/2 green|momentum/i);
    expect(entryCandleConfirmDeny('BUY', bars, { soft: true })).toMatch(/2 green|momentum|green/i);
  });

  it('soft: pause doji after dump reds does NOT block SELL (5-red class)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 6; i++) bars.push(candle(4436, 4437, 4435, 4436));
    // 5 red dump
    bars.push(candle(4436, 4436.2, 4434, 4434.2));
    bars.push(candle(4434.2, 4434.3, 4432, 4432.1));
    bars.push(candle(4432.1, 4432.2, 4430, 4430.2));
    bars.push(candle(4430.2, 4430.3, 4428.5, 4428.6));
    bars.push(candle(4428.6, 4428.7, 4427.5, 4427.6));
    // Pause doji / micro-green — live desk said "need closed red" forever
    bars.push(candle(4427.6, 4427.8, 4427.5, 4427.7));
    expect(entryCandleConfirmDeny('SELL', bars)).toMatch(/red/i);
    expect(entryCandleConfirmDeny('SELL', bars, { soft: true })).toBeNull();
  });

  it('soft: proven dump + last red enters without 2-red wait', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 6; i++) bars.push(candle(4436, 4437, 4435, 4436));
    bars.push(candle(4436, 4436.2, 4434, 4434.2));
    bars.push(candle(4434.2, 4434.3, 4432, 4432.1));
    bars.push(candle(4432.1, 4432.5, 4431.8, 4432.3)); // small green blip
    bars.push(candle(4432.3, 4432.4, 4430.5, 4430.6)); // red — only one after green
    expect(entryCandleConfirmDeny('SELL', bars)).toMatch(/2 red|momentum/i);
    expect(entryCandleConfirmDeny('SELL', bars, { soft: true })).toBeNull();
  });

  it('soft: directional dump spike still waits next bar', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 8; i++) bars.push(candle(4435, 4435.4, 4434.6, 4435.1));
    bars.push(candle(4435.1, 4435.2, 4428.0, 4428.2)); // dump spike red
    expect(entryCandleConfirmDeny('SELL', bars)).toMatch(/spike/i);
    expect(entryCandleConfirmDeny('SELL', bars, { soft: true })).toMatch(/spike/i);
  });
});
