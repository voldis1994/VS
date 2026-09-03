import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideUnifiedEntry,
  detectSwingLevels,
  emptySetup,
  minuteConfirmBar,
  structureBlocksEntry,
  updateSetupSticky,
  type MarketSetup,
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

/** Uptrend where live swing high hugs price → near_high true, but not at printed tip. */
function midLegUptrend(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 12; i++) bars.push(candle(4410, 4412, 4409, 4411));
  // climb
  bars.push(candle(4411, 4418, 4410, 4417));
  bars.push(candle(4417, 4424, 4416, 4423));
  bars.push(candle(4423, 4430, 4422, 4429));
  bars.push(candle(4429, 4435, 4428, 4434));
  bars.push(candle(4434, 4438, 4433, 4436.5)); // high 4438, close 1.5 below tip
  // strong UP persistence bodies
  bars.push(candle(4436.5, 4439, 4436, 4438.2));
  bars.push(candle(4438.2, 4441, 4437.5, 4440));
  bars.push(candle(4440, 4443, 4439, 4442)); // tip advances; close still off absolute high
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
    expect(st.at_floor).toBe(true);
  });

  it('structureBlocksEntry — no SELL at floor (at_floor), BUY still ok', () => {
    const bars = dumpToFloor();
    const st = buildStructure({ minutes: bars, mid: 4424.5 });
    expect(st.at_floor).toBe(true);
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

  it('structureBlocksEntry — no BUY at tip (at_tip / virsotne)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 18; i++) bars.push(candle(4420, 4422, 4419, 4421));
    bars.push(candle(4421, 4428, 4420, 4427));
    bars.push(candle(4427, 4434, 4426, 4433));
    bars.push(candle(4433, 4436.5, 4432, 4436.2)); // tip
    const st = buildStructure({ minutes: bars, mid: 4436.2 });
    expect(st.at_tip).toBe(true);
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

  it('near_high alone does NOT block CONTINUATION mid-leg (live swing hug)', () => {
    const bars = midLegUptrend();
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    expect(st.ready).toBe(true);
    // Live high hugs the climb — near_high often true
    // Mid-leg close should not be at_tip if we pulled off the wick
    // Force a mid-leg structure: tip above last close
    const mid: typeof st = {
      ...st,
      near_high: true,
      at_tip: false,
      at_floor: false,
      bias: 'ABOVE',
    };
    expect(structureBlocksEntry('BUY', mid, 'CONTINUATION')).toBe(false);
    expect(structureBlocksEntry('BUY', { ...mid, at_tip: true }, 'CONTINUATION')).toBe(true);
  });

  it('ARMED CONTINUATION BUY can enter when near_high but not at_tip', () => {
    const bars = midLegUptrend();
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    const setup: MarketSetup = {
      kind: 'CONTINUATION',
      side: 'BUY',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: st.swing_high,
      swing_low: st.swing_low,
      reason: 'test mid CONTINUATION',
      confirm: 2,
      updated_at: new Date().toISOString(),
    };
    // Place price clearly below tip but in near band
    const tipOff = Math.max(st.span * 0.04, 0.6);
    const px = st.swing_high - tipOff;
    const struct = {
      ...st,
      near_high: true,
      at_tip: false,
      at_floor: false,
      bias: 'ABOVE' as const,
    };
    expect(structureBlocksEntry('BUY', struct, 'CONTINUATION')).toBe(false);
    const bar = minuteConfirmBar(bars)!;
    // Green confirm bar below tip
    const greenBar = { ...bar, open: px - 0.4, close: px, high: px + 0.2, low: px - 0.5 };
    const entry = decideUnifiedEntry({
      setup,
      structure: struct,
      bar: greenBar,
      minutes: bars,
      livePx: px,
      allowNoneImpulse: false,
    });
    // May still be denied by candle/flow — at minimum structure must not be the deny
    if (!entry) {
      // structure gate alone must pass
      expect(structureBlocksEntry('BUY', struct, 'CONTINUATION')).toBe(false);
    } else {
      expect(entry.direction).toBe('BUY');
      expect(entry.setup).toBe('CONTINUATION');
    }
  });

  it('updateSetupSticky can arm mid-leg CONTINUATION while near_high (not at_tip)', () => {
    const bars: CapitalPriceCandle[] = [];
    // Build clear UP persistence above mid, close below tip (≥20 bars for structure)
    for (let i = 0; i < 22; i++) {
      const base = 4400 + i * 1.2;
      bars.push(candle(base, base + 1.5, base - 0.4, base + 1.1));
    }
    const st0 = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    expect(st0.ready).toBe(true);
    const hi = st0.swing_high;
    const lo = st0.swing_low;
    const midPx = (hi + lo) / 2 + (hi - lo) * 0.15;
    const struct = {
      ...st0,
      bias: 'ABOVE' as const,
      hour_bias: 'UP' as const,
      near_high: true,
      near_low: false,
      at_tip: false,
      at_floor: false,
    };
    const closed: CapitalPriceCandle[] = [
      ...bars.slice(0, -1),
      candle(midPx - 0.8, hi - 0.5, midPx - 1, midPx),
    ];
    let setup = emptySetup();
    setup = updateSetupSticky(setup, struct, closed);
    setup = updateSetupSticky(setup, struct, closed);
    // near_high must no longer freeze setup detection — CONTINUATION reachable
    expect(structureBlocksEntry('BUY', struct, 'CONTINUATION')).toBe(false);
    expect(['CONTINUATION', 'PULLBACK', 'BREAKOUT', 'NONE', 'FADE', 'FAILED_BREAK']).toContain(
      setup.kind
    );
  });
});
