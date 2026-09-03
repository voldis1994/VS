import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideUnifiedEntry,
  detectSwingLevels,
  emptySetup,
  minuteConfirmBar,
  structureBlocksEntry,
} from './marketSetup.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

function dumpToFloor(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 18; i++) bars.push(candle(4435, 4437, 4434, 4436));
  bars.push(candle(4436, 4438, 4430, 4431));
  bars.push(candle(4431, 4432, 4426, 4427));
  bars.push(candle(4427, 4428, 4424.2, 4424.5)); // live floor — must be visible NOW
  return bars;
}

describe('faster structure — live low visible now', () => {
  it('detectSwingLevels includes the last-bar low (not 3m late)', () => {
    const bars = dumpToFloor();
    const sw = detectSwingLevels(bars);
    expect(sw.ok).toBe(true);
    expect(sw.low).toBeLessThanOrEqual(4424.3);
  });

  it('buildStructure snaps swing_low on wick break immediately', () => {
    const base = dumpToFloor().slice(0, -1);
    const prev = buildStructure({ minutes: base, mid: 4427 });
    expect(prev.ready).toBe(true);
    const withFloor = dumpToFloor();
    const st = buildStructure({
      minutes: withFloor,
      mid: 4424.5,
      prev,
    });
    expect(st.swing_low).toBeLessThanOrEqual(4424.3);
    expect(st.near_low).toBe(true);
  });

  it('structureBlocksEntry — no SELL at near_low (4424 floor class)', () => {
    const bars = dumpToFloor();
    const st = buildStructure({ minutes: bars, mid: 4424.5 });
    expect(st.near_low).toBe(true);
    expect(structureBlocksEntry('SELL', st)).toBe(true);
    expect(structureBlocksEntry('BUY', st)).toBe(false);
    const bar = minuteConfirmBar(bars)!;
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar,
        minutes: bars,
        livePx: 4424.5,
        allowNoneImpulse: true,
      })?.direction
    ).not.toBe('SELL');
  });

  it('structureBlocksEntry — no BUY at near_high (virsotne)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 18; i++) bars.push(candle(4420, 4422, 4419, 4421));
    bars.push(candle(4421, 4428, 4420, 4427));
    bars.push(candle(4427, 4434, 4426, 4433));
    bars.push(candle(4433, 4436.5, 4432, 4436.2)); // tip
    const st = buildStructure({ minutes: bars, mid: 4436.2 });
    expect(st.near_high).toBe(true);
    expect(structureBlocksEntry('BUY', st)).toBe(true);
    expect(structureBlocksEntry('SELL', st)).toBe(false);
    // BREAKOUT through high still allowed
    expect(structureBlocksEntry('BUY', st, 'BREAKOUT')).toBe(false);
    const bar = minuteConfirmBar(bars)!;
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar,
        minutes: bars,
        livePx: 4436.2,
        allowNoneImpulse: true,
      })?.direction
    ).not.toBe('BUY');
  });
});
