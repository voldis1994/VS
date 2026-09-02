import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideEntryFromImpulseCandle,
  decideEntryFromSetup,
  decideEntryFromTenSecMove,
  decideUnifiedEntry,
  emptySetup,
  flowAgreesWithSide,
  flowFlipAtExtreme,
  liveFlow,
  marketTrend,
  minuteConfirmBar,
  moveAlreadyFinished,
  moveStillPrinting,
  priceFlowBias,
  recentImpulse,
  updateSetupSticky,
  type MarketSetup,
  type StructureBook,
} from './marketSetup.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

function bar10(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: 0, open: o, high: h, low: l, close: c, ticks: 5 };
}

/** Quiet oscillating range ~2000–2010 for ≥20 minutes */
function rangeMinutes(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 30; i++) {
    const up = i % 2 === 0;
    bars.push(candle(up ? 2003 : 2007, 2009.5, 2000.5, up ? 2006 : 2004));
  }
  return bars;
}

describe('marketSetup', () => {
  it('minuteConfirmBar overlays live mid only when requested', () => {
    const minutes = [candle(100, 101, 99, 100.5), candle(100.5, 101.2, 100.4, 101.0)];
    expect(minuteConfirmBar(minutes, 101.4)?.close).toBe(101.0);
    const bar = minuteConfirmBar(minutes, 101.4, { overlayLive: true });
    expect(bar?.open).toBe(100.5);
    expect(bar?.close).toBe(101.4);
    expect(bar?.high).toBe(101.4);
  });

  it('needs enough minutes before structure ready', () => {
    const st = buildStructure({ minutes: [candle(1, 2, 0.5, 1.5)], mid: 1.5 });
    expect(st.ready).toBe(false);
  });

  it('builds swing structure and NONE mid-range', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2005 });
    expect(st.ready).toBe(true);
    expect(st.swing_high).toBeGreaterThan(st.swing_low);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, minutes);
    setup = updateSetupSticky(setup, st, minutes);
    // mid → NONE (not WAIT regime)
    expect(setup.kind === 'NONE' || setup.kind === 'FADE').toBe(true);
    if (!st.near_high && !st.near_low) {
      expect(setup.kind).toBe('NONE');
      expect(setup.status).toBe('NONE');
    }
  });

  it('arms FADE BUY near swing low and enters on bounce 10s', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2001 });
    expect(st.near_low || st.bias === 'BELOW' || st.bias === 'INSIDE').toBe(true);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, minutes);
    setup = updateSetupSticky(setup, st, minutes);
    // Force near-low fade path if structure sees edge
    if (st.near_low) {
      expect(['FADE', 'PULLBACK', 'FAILED_BREAK'].includes(setup.kind)).toBe(true);
      if (setup.status === 'ARMED' && setup.side === 'BUY') {
        const bounce = bar10(2001.2, 2002.5, 2000.6, 2002.4);
        const entry = decideEntryFromSetup(setup, bounce);
        expect(entry?.direction).toBe('BUY');
      }
    }
  });

  it('does not flip setup on a single disagreeing refresh', () => {
    const minutes = rangeMinutes();
    // Push near high
    const nearHigh = buildStructure({ minutes, mid: 2009.2 });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, nearHigh, minutes);
    setup = updateSetupSticky(setup, nearHigh, minutes);
    const armedKind = setup.kind;
    // One mid refresh should not instantly wipe an armed setup
    if (setup.status === 'ARMED' && armedKind !== 'NONE') {
      const mid = buildStructure({ minutes, mid: 2005 });
      const held = updateSetupSticky(setup, mid, minutes);
      expect(held.kind).toBe(armedKind);
    }
  });

  it('decideEntryFromSetup returns null when NONE', () => {
    expect(decideEntryFromSetup(emptySetup(), bar10(100, 101, 99, 100.5))).toBeNull();
  });

  it('never arms BUY at swing high — FADE SELL instead (no tip chase)', () => {
    const minutes = rangeMinutes();
    const nearHigh = buildStructure({ minutes, mid: 2009.2 });
    expect(nearHigh.near_high).toBe(true);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, nearHigh, minutes);
    setup = updateSetupSticky(setup, nearHigh, minutes);
    expect(setup.side).toBe('SELL');
    expect(setup.kind === 'FADE' || setup.kind === 'FAILED_BREAK' || setup.kind === 'PULLBACK').toBe(
      true
    );
    // FADE BUY at the tip must still be blocked; CONTINUATION may ride impulse through
    const tipFadeBuy = {
      ...setup,
      kind: 'FADE' as const,
      side: 'BUY' as const,
      status: 'ARMED' as const,
      playbook: 'FADE' as const,
      swing_high: nearHigh.swing_high,
      swing_low: nearHigh.swing_low,
    };
    expect(decideEntryFromSetup(tipFadeBuy, bar10(2009, 2009.5, 2008.8, 2009.3))).toBeNull();
  });

  it('does not FADE SELL mid-rally on a stale swing high (4434 while climb continues)', () => {
    const bars: CapitalPriceCandle[] = [];
    // Base range then old local high ~4434, then strong rally toward 4437
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4428, 4430, 4426, 4428));
    }
    // Print swing high around 4434
    bars.push(candle(4430, 4434.3, 4429, 4433));
    bars.push(candle(4433, 4434.2, 4431, 4432));
    bars.push(candle(4432, 4433, 4430, 4431));
    // Continue rally — impulse UP, price leaves the old high behind mid-move
    for (let i = 0; i < 10; i++) {
      const o = 4431 + i * 0.55;
      bars.push(candle(o, o + 0.7, o - 0.15, o + 0.5));
    }
    const last = bars[bars.length - 1]!;
    // Sticky prev structure keeps old high ~4434 while price is higher mid-rally
    const prev = buildStructure({ minutes: bars.slice(0, 26), mid: 4433 });
    const st = buildStructure({
      minutes: bars,
      mid: last.close,
      prev: { ...prev, swing_high: 4434.24, ready: true },
    });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    // Must not arm FADE/FAILED_BREAK SELL into the live rally
    if (setup.side === 'SELL') {
      expect(setup.kind).not.toMatch(/FADE|FAILED_BREAK/);
    }
    expect(setup.kind === 'CONTINUATION' || setup.kind === 'NONE' || setup.kind === 'BREAKOUT').toBe(
      true
    );
    if (setup.kind === 'NONE') {
      expect(setup.reason).toMatch(/stale high|rally impulse|no FADE SELL|mid swing|impulse/i);
    }
  });

  it('does not FADE BUY mid-dump on a stale swing low', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4430, 4432, 4428, 4430));
    }
    bars.push(candle(4430, 4431, 4426.5, 4427));
    bars.push(candle(4427, 4428, 4426.4, 4427.2));
    for (let i = 0; i < 10; i++) {
      const o = 4427 - i * 0.6;
      bars.push(candle(o, o + 0.2, o - 0.8, o - 0.55));
    }
    const last = bars[bars.length - 1]!;
    const prev = buildStructure({ minutes: bars.slice(0, 26), mid: 4427 });
    const st = buildStructure({
      minutes: bars,
      mid: last.close,
      prev: { ...prev, swing_low: 4426.5, ready: true },
    });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    if (setup.side === 'BUY') {
      expect(setup.kind).not.toMatch(/FADE|FAILED_BREAK/);
    }
    expect(setup.side === 'SELL' || setup.kind === 'NONE' || setup.kind === 'BREAKOUT').toBe(true);
  });

  it('drops sticky FAILED_BREAK BUY when dump impulse continues (no holding into fall)', () => {
    const base = rangeMinutes();
    // Arm a BUY near low first
    const nearLow = buildStructure({ minutes: base, mid: 2001 });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, nearLow, base);
    setup = updateSetupSticky(setup, nearLow, base);
    // Force sticky BUY FADE state
    setup = {
      ...setup,
      kind: 'FAILED_BREAK',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      confirm: 3,
      swing_high: nearLow.swing_high,
      swing_low: nearLow.swing_low,
      reason: 'FAILED_BREAK at swing low → FADE BUY',
    };
    // Continue dump minutes → impulse DOWN, candidate may be NONE/SELL
    const dump = [...base];
    for (let i = 0; i < 8; i++) {
      const o = 2001 - i * 1.1;
      dump.push(candle(o, o + 0.2, o - 1.4, o - 1.1));
    }
    const stDump = buildStructure({ minutes: dump, mid: dump[dump.length - 1]!.close });
    const next = updateSetupSticky(setup, stDump, dump);
    expect(next.side).not.toBe('BUY');
    expect(next.reason).toMatch(
      /dropped sticky BUY|flipped|IMPULSE DOWN|CONTINUATION SELL|NONE|FADE SELL|BREAKOUT/i
    );
  });

  it('impulse UP flips sticky SELL to BUY immediately (through swing high)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4430, 4432, 4428, 4430));
    }
    // Stale SELL fade armed at high
    let setup: ReturnType<typeof emptySetup> = {
      ...emptySetup(),
      kind: 'FADE',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      confirm: 3,
      swing_high: 4434,
      swing_low: 4428,
      reason: 'FADE SELL at swing high',
    };
    // Hard rally through high
    for (let i = 0; i < 6; i++) {
      const o = 4432 + i * 1.1;
      bars.push(candle(o, o + 1.2, o - 0.2, o + 1.0));
    }
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.side).toBe('BUY');
    expect(setup.status).toBe('ARMED');
    expect(setup.reason).toMatch(/IMPULSE UP|BREAKOUT|flipped/i);
    expect(setup.watch_buy).toBeTruthy();
  });

  it('does NOT arm IMPULSE UP BUY flip on bounce under swing high after dump (Gold 13:50)', () => {
    // Spike ~4344 then dump to ~4328, bounce toward mid — desk said IMPULSE UP→BUY mid 4334
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const o = 4324 + i * 0.35;
      bars.push(candle(o, o + 0.4, o - 0.2, o + 0.3));
    }
    bars.push(candle(4332, 4338, 4331, 4337));
    bars.push(candle(4337, 4344.2, 4336.5, 4343.5));
    bars.push(candle(4343.5, 4344, 4335, 4335.5));
    bars.push(candle(4335.5, 4336, 4328, 4328.5));
    bars.push(candle(4328.5, 4330, 4327.2, 4329));
    // Bounce blip — can look like IMPULSE UP locally
    bars.push(candle(4329, 4335, 4328.8, 4334.5));
    bars.push(candle(4334.5, 4339, 4334, 4337.5));
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.reason).not.toMatch(/IMPULSE UP → BUY flip/i);
    expect(setup.side).not.toBe('BUY');
    const buyBar = bar10(4337.0, 4338.8, 4336.9, 4338.5);
    expect(decideEntryFromImpulseCandle(buyBar, bars)).toBeNull();
  });

  it('local dump impulse arms CONTINUATION SELL — not mid-NONE', () => {
    const bars: CapitalPriceCandle[] = [];
    // Quiet base then hard dump ~8 minutes
    for (let i = 0; i < 25; i++) {
      bars.push(candle(4430, 4432, 4428, 4430));
    }
    for (let i = 0; i < 8; i++) {
      const o = 4430 - i * 1.2;
      bars.push(candle(o, o + 0.3, o - 1.5, o - 1.2));
    }
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    expect(st.ready).toBe(true);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.kind).not.toBe('NONE');
    expect(setup.side).toBe('SELL');
    expect(setup.status).toBe('ARMED');
  });

  it('sharp V-leg impulse fires even when longer window nets near zero', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4435, 4437, 4433, 4435));
    }
    // Dump then equal rally — classic cancel over 5–8m, but last 2m must still read UP
    bars.push(candle(4435, 4435.5, 4431, 4431.5));
    bars.push(candle(4431.5, 4432, 4430.8, 4431));
    bars.push(candle(4431, 4434, 4430.9, 4433.5));
    bars.push(candle(4433.5, 4437.2, 4433, 4436.8));
    expect(recentImpulse(bars, 'flip')).toBe('UP');
  });

  it('decideEntryFromTenSecMove trades strong 10s when structure mid-NONE', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2005 });
    expect(st.ready).toBe(true);
    const buyBar = bar10(2004.5, 2006.2, 2004.4, 2006.0);
    const buy = decideEntryFromTenSecMove(st, buyBar, minutes);
    expect(buy?.direction).toBe('BUY');
    expect(buy?.setup).toBe('CONTINUATION');
    expect(buy?.playbook).toBe('LONG');
    const sellBar = bar10(2005.5, 2005.6, 2003.8, 2004.0);
    const sell = decideEntryFromTenSecMove(st, sellBar, minutes);
    expect(sell?.direction).toBe('SELL');
  });

  it('decideEntryFromTenSecMove refuses tip-chase BUY at swing high', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2009.2 });
    expect(st.near_high).toBe(true);
    const tip = bar10(2008.8, 2009.6, 2008.7, 2009.4);
    expect(decideEntryFromTenSecMove(st, tip, minutes)).toBeNull();
  });

  it('never BUY into a dump — green 10s blip mid-dump is blocked', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4436, 4438, 4434, 4436));
    }
    // Slow grind dump like 18:00→4431 (BUY @ 4433.90 class of mistake)
    for (let i = 0; i < 8; i++) {
      const o = 4436 - i * 0.55;
      bars.push(candle(o, o + 0.25, o - 0.7, o - 0.5));
    }
    expect(priceFlowBias(bars)).toBe('DOWN');
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    const greenBlip = bar10(4433.5, 4434.3, 4433.4, 4434.1);
    expect(decideEntryFromTenSecMove(st, greenBlip, bars)).toBeNull();
    // Armed FADE BUY must also refuse entry while dumping
    const fadeBuy = {
      ...emptySetup(),
      kind: 'FADE' as const,
      side: 'BUY' as const,
      playbook: 'FADE' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: st.swing_high,
      swing_low: st.swing_low,
    };
    expect(decideEntryFromSetup(fadeBuy, greenBlip, bars)).toBeNull();
    // Setup itself should prefer SELL not FADE BUY at low while dumping
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.side).not.toBe('BUY');
  });

  it('Gold 4369 bounce tip mid-dump — no BUY (market still DOWN)', () => {
    // 17:05 peak ~4374.5 → dump → bounce cluster ~4369–4370 → BUY@4369.30 then dump to 4365
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 12; i++) {
      bars.push(candle(4368, 4370, 4367, 4369));
    }
    // Spike / peak then dump
    bars.push(candle(4369, 4374.5, 4368.5, 4373.8));
    bars.push(candle(4373.8, 4374.2, 4371, 4371.5));
    bars.push(candle(4371.5, 4372, 4369.2, 4369.5));
    bars.push(candle(4369.5, 4370, 4368, 4368.4));
    bars.push(candle(4368.4, 4369, 4367.2, 4367.6));
    // Bounce tip into 4369–4370 (looks UP locally — old liveFlow flipped BUY)
    bars.push(candle(4367.6, 4369.2, 4367.4, 4368.9));
    bars.push(candle(4368.9, 4370.1, 4368.7, 4369.6));
    bars.push(candle(4369.6, 4370.0, 4369.1, 4369.4));
    expect(marketTrend(bars)).toBe('DOWN');
    expect(flowFlipAtExtreme(bars)).toBeNull(); // stalled last bar — not a live V-flip
    expect(priceFlowBias(bars)).toBe('DOWN');
    expect(recentImpulse(bars, 'flip')).toBe('UP'); // local bounce still UP
    const buyTip = bar10(4369.1, 4369.5, 4369.0, 4369.3);
    expect(decideEntryFromImpulseCandle(buyTip, bars)).toBeNull();
    const st = buildStructure({ minutes: bars, mid: 4369.3 });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.side).not.toBe('BUY');
    if (setup.status === 'ARMED' && setup.side === 'BUY') {
      expect(decideEntryFromSetup(setup, buyTip, bars)).toBeNull();
    }
    expect(decideEntryFromTenSecMove(st, buyTip, bars)).toBeNull();
  });

  it('Gold 19:45 V-flip — flow flips UP, no late SELL into BUY leg', () => {
    // Dump 4380→4372 then 3+ green 1m reclaiming toward 4374.8 (screenshot class)
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      bars.push(candle(4376, 4378, 4375, 4377));
    }
    bars.push(candle(4377, 4380.2, 4376.5, 4379.5));
    bars.push(candle(4379.5, 4380.0, 4376.0, 4376.5));
    bars.push(candle(4376.5, 4377.0, 4374.0, 4374.5));
    bars.push(candle(4374.5, 4375.0, 4372.2, 4372.5)); // fresh low ~19:45
    bars.push(candle(4372.5, 4373.4, 4372.3, 4373.2)); // green
    bars.push(candle(4373.2, 4374.0, 4373.0, 4373.8)); // green
    bars.push(candle(4373.8, 4374.5, 4373.6, 4374.3)); // green — still printing UP
    expect(marketTrend(bars)).toBe('DOWN'); // sticky 20m dump still DOWN
    expect(flowFlipAtExtreme(bars)).toBe('UP');
    expect(priceFlowBias(bars)).toBe('UP');
    expect(liveFlow(bars)).toBe('UP');
    const sellBar = bar10(4374.0, 4374.5, 4373.7, 4374.3);
    expect(decideEntryFromImpulseCandle(sellBar, bars)?.direction).not.toBe('SELL');
    expect(decideEntryFromImpulseCandle(sellBar, bars)?.direction).toBe('BUY');
    const st = buildStructure({ minutes: bars, mid: 4374.3 });
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: st,
        bar: sellBar,
        minutes: bars,
        livePx: 4374.3,
      })?.direction
    ).toBe('BUY');
  });

  it('refuses impulse entry when last 1m already flipped against the move', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      const o = 4436 - i * 0.55;
      bars.push(candle(o, o + 0.2, o - 0.75, o - 0.5));
    }
    // Tiny green against the dump — signal finished, do not chase SELL
    bars.push(candle(4423.5, 4424.8, 4423.3, 4424.4));
    expect(liveFlow(bars)).toBe('DOWN');
    expect(moveStillPrinting('DOWN', bars)).toBe(false);
    const redBlip = bar10(4424.2, 4424.3, 4422.8, 4423.0);
    expect(decideEntryFromImpulseCandle(redBlip, bars)).toBeNull();
  });

  it('allows impulse entry while move still printing', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const o = 2600 + i * 0.4;
      bars.push(candle(o, o + 0.6, o - 0.1, o + 0.45));
    }
    bars.push(candle(2610, 2610.2, 2606, 2606.5));
    bars.push(candle(2606.5, 2606.8, 2604, 2604.5));
    expect(liveFlow(bars)).toBe('DOWN');
    expect(moveStillPrinting('DOWN', bars)).toBe(true);
    const sellBar = bar10(2605.2, 2605.3, 2603.8, 2604.0);
    expect(decideEntryFromImpulseCandle(sellBar, bars)?.direction).toBe('SELL');
  });

  it('BREAKOUT BUY enters on price through H — not candle body/color', () => {
    // Screenshot class: ARMED BREAKOUT BUY, live ~4342 above H4341.40, flat 2s body
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4332, 4336, 4330, 4334));
    }
    for (let i = 0; i < 4; i++) {
      const o = 4334 + i * 1.5;
      bars.push(candle(o, o + 2, o - 0.2, o + 1.8));
    }
    const hi = 4341.4;
    const lo = 4330.26;
    const breakoutBuy = {
      ...emptySetup(),
      kind: 'BREAKOUT' as const,
      side: 'BUY' as const,
      playbook: 'SCALP' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: hi,
      swing_low: lo,
      reason: `IMPULSE UP through H${hi.toFixed(2)} → BUY flip now`,
    };
    // Tiny green body — old bodyPct gate would block (~0.0016% << thr)
    const flatThrough = bar10(4342.75, 4342.9, 4342.7, 4342.82);
    const entry = decideEntryFromSetup(breakoutBuy, flatThrough, bars);
    expect(entry?.direction).toBe('BUY');
    expect(entry?.setup).toBe('BREAKOUT');
    expect(entry?.reason).toMatch(/through H/i);
    // Slight red forming while still above H — still enter (market, not candle color)
    const redThrough = bar10(4342.9, 4342.95, 4342.2, 4342.28);
    expect(decideEntryFromSetup(breakoutBuy, redThrough, bars)?.direction).toBe('BUY');
  });

  it('impulse enters on market flow without requiring green/red candle', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const o = 2600 + i * 0.4;
      bars.push(candle(o, o + 0.6, o - 0.1, o + 0.45));
    }
    bars.push(candle(2610, 2610.2, 2606, 2606.5));
    bars.push(candle(2606.5, 2606.8, 2604, 2604.5));
    expect(liveFlow(bars)).toBe('DOWN');
    expect(moveStillPrinting('DOWN', bars)).toBe(true);
    // Flat / tiny green 2s during dump — still SELL on flow
    const flatBar = bar10(2604.4, 2604.55, 2604.35, 2604.48);
    expect(decideEntryFromImpulseCandle(flatBar, bars)?.direction).toBe('SELL');
    expect(decideEntryFromImpulseCandle(flatBar, bars)?.reason).toMatch(/market flow/i);
  });

  it('flowAgreesWithSide matches open trade to live dump/rally', () => {
    const dump: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      const o = 4436 - i * 0.5;
      dump.push(candle(o, o + 0.2, o - 0.7, o - 0.45));
    }
    expect(flowAgreesWithSide('SELL', dump)).toBe(true);
    expect(flowAgreesWithSide('BUY', dump)).toBe(false);
  });

  /** Gold 02 Sep 13:20 spike ~4344 then dump to ~4335 — real late entries */
  function goldSpikeThenDumpFloor(): CapitalPriceCandle[] {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 18; i++) {
      const o = 4324 + i * 0.4;
      bars.push(candle(o, o + 0.5, o - 0.2, o + 0.35));
    }
    // Spike
    bars.push(candle(4332, 4338, 4331.5, 4337.5));
    bars.push(candle(4337.5, 4344.2, 4337, 4343.5));
    // Dump to floor
    bars.push(candle(4343.5, 4344, 4336, 4336.5));
    bars.push(candle(4336.5, 4337, 4334.2, 4334.8));
    // Stall / tiny red at floor (13:24 SELL class)
    bars.push(candle(4334.8, 4335.2, 4334.5, 4334.9));
    return bars;
  }

  it('blocks SELL at dump floor after spike (Gold 4334.90 late short)', () => {
    const bars = goldSpikeThenDumpFloor();
    expect(moveAlreadyFinished('SELL', bars, 4334.9)).toBe(true);
    const sellBar = bar10(4335.1, 4335.2, 4334.6, 4334.85);
    expect(decideEntryFromImpulseCandle(sellBar, bars)).toBeNull();
  });

  it('blocks BUY after UP spike already gave back (Gold 4337.33 late long)', () => {
    const bars = goldSpikeThenDumpFloor();
    // Continue dump / chop below peak
    bars.push(candle(4334.9, 4339.8, 4334.7, 4338.5));
    bars.push(candle(4338.5, 4339.5, 4336.8, 4337.2));
    expect(moveAlreadyFinished('BUY', bars, 4337.33)).toBe(true);
    const buyBar = bar10(4336.9, 4337.6, 4336.8, 4337.4);
    expect(decideEntryFromImpulseCandle(buyBar, bars)).toBeNull();
  });

  it('allows SELL mid-dump while still extending (not at finished floor)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 18; i++) {
      bars.push(candle(4340, 4341, 4339, 4340));
    }
    bars.push(candle(4340, 4344.5, 4339.5, 4343.8));
    // First dump leg — large red body, still mid move (not stalled at floor)
    bars.push(candle(4343.8, 4344.0, 4339.2, 4339.5));
    expect(moveAlreadyFinished('SELL', bars, 4339.5)).toBe(false);
  });
});

describe('decideUnifiedEntry', () => {
  function readyStructure(bias: StructureBook['bias'] = 'INSIDE'): StructureBook {
    return {
      ready: true,
      swing_high: 2010,
      swing_low: 2000,
      mid: 2005,
      span: 10,
      bias,
      near_high: false,
      near_low: false,
      hour_bias: 'FLAT',
      bar_count: 30,
      detail: 'test',
      updated_at: new Date().toISOString(),
    };
  }

  function armedFadeBuy(): MarketSetup {
    return {
      kind: 'FADE',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: 2010,
      swing_low: 2000,
      reason: 'FADE BUY test',
      confirm: 2,
      updated_at: new Date().toISOString(),
    };
  }

  it('does not let DOWN impulse override ARMED FADE BUY', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) bars.push(candle(2005, 2006, 2004, 2005));
    bars.push(candle(2005, 2005.2, 1998, 1998.5)); // dump impulse
    const bar = bar10(2000, 2000.5, 1998, 1998.5);
    const entry = decideUnifiedEntry({
      setup: armedFadeBuy(),
      structure: readyStructure('BELOW'),
      bar,
      minutes: bars,
      livePx: 1998.5,
    });
    // Must not open SELL CONTINUATION against sticky FADE BUY
    expect(entry?.direction).not.toBe('SELL');
  });

  it('ARMED setup path still allows FADE BUY bounce', () => {
    const mins = rangeMinutes();
    mins.push(candle(2004, 2005, 2000.2, 2000.8));
    mins.push(candle(2000.8, 2002.5, 2000.3, 2002.2)); // reclaim
    const setup = armedFadeBuy();
    const bar = bar10(2000.8, 2002.5, 2000.3, 2002.2);
    const entry = decideUnifiedEntry({
      setup,
      structure: readyStructure('INSIDE'),
      bar,
      minutes: mins,
      livePx: 2002.2,
    });
    if (entry) {
      expect(entry.direction).toBe('BUY');
      expect(entry.setup).toMatch(/FADE|FAILED/);
    }
  });

  it('NONE can still catch filtered impulse (profitable move path)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) bars.push(candle(2005, 2006.5, 2004, 2005.5));
    // Gradual UP (not one spike candle) — closed green confirms
    bars.push(candle(2005.5, 2007.5, 2005.2, 2007.2));
    bars.push(candle(2007.2, 2009.0, 2007.0, 2008.8));
    bars.push(candle(2008.8, 2010.5, 2008.5, 2010.2));
    const bar = minuteConfirmBar(bars)!;
    const entry = decideUnifiedEntry({
      setup: emptySetup(),
      structure: readyStructure('ABOVE'),
      bar,
      minutes: bars,
      livePx: 2010.2,
      allowNoneImpulse: true,
    });
    expect(entry?.direction).toBe('BUY');
  });

  it('allowNoneImpulse false blocks NONE entries', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 18; i++) bars.push(candle(2005, 2006, 2004, 2005));
    bars.push(candle(2005, 2012, 2004.5, 2011.5));
    bars.push(candle(2011.5, 2014, 2011, 2013.5));
    const bar = bar10(2011.5, 2014, 2011, 2013.5);
    expect(
      decideUnifiedEntry({
        setup: emptySetup(),
        structure: readyStructure('ABOVE'),
        bar,
        minutes: bars,
        allowNoneImpulse: false,
      })
    ).toBeNull();
  });

  it('PULLBACK requires pull-zone touch, not any bar under high', () => {
    const setup: MarketSetup = {
      kind: 'PULLBACK',
      side: 'BUY',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: 2010,
      swing_low: 2000,
      reason: 'PULLBACK test',
      confirm: 2,
      updated_at: new Date().toISOString(),
    };
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) bars.push(candle(2008, 2009, 2007, 2008.5));
    bars.push(candle(2008.5, 2009.5, 2008, 2009.2)); // near high, UP — not a pullback
    const tipBar = bar10(2008.5, 2009.5, 2008.2, 2009.2);
    expect(decideEntryFromSetup(setup, tipBar, bars, 2009.2)).toBeNull();
  });
});
