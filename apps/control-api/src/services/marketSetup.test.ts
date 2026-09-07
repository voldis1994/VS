import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideEntryFromSetup,
  decideEntryFromTenSecMove,
  emptySetup,
  priceFlowBias,
  recentImpulse,
  updateSetupSticky,
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
  it('needs enough minutes before structure ready', () => {
    const st = buildStructure({ minutes: [candle(1, 2, 0.5, 1.5)], mid: 1.5 });
    expect(st.ready).toBe(false);
  });

  it('builds swing structure and ARMS mid-range with last 1m (no impulse starve)', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2005 });
    expect(st.ready).toBe(true);
    expect(st.swing_high).toBeGreaterThan(st.swing_low);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, minutes);
    setup = updateSetupSticky(setup, st, minutes);
    // Never sit NONE waiting for impulse — arm CONTINUATION from flow/1m
    expect(setup.kind).toBe('CONTINUATION');
    expect(setup.status).toBe('ARMED');
    expect(setup.side === 'BUY' || setup.side === 'SELL').toBe(true);
  });

  it('Gold dump mid-swing ARMS SELL — not NONE no impulse yet', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 24; i++) {
      const o = 4417 - i * 0.28;
      bars.push(candle(o, o + 0.4, o - 0.5, o - 0.25));
    }
    const last = bars[bars.length - 1]!;
    const st = buildStructure({ minutes: bars, mid: last.close });
    expect(st.ready).toBe(true);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.kind).not.toBe('NONE');
    expect(setup.side).toBe('SELL');
    expect(setup.status).toBe('ARMED');
    expect(setup.reason).not.toMatch(/no impulse yet/i);
    const red10 = bar10(last.close + 0.05, last.close + 0.06, last.close - 0.1, last.close - 0.02);
    const sell =
      decideEntryFromSetup(setup, red10, bars) || decideEntryFromTenSecMove(st, red10, bars);
    expect(sell?.direction).toBe('SELL');
  });

  it('arms WITH-MOVE near swing low — BUY when flow up / bounce, never FADE against dump', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2001 });
    expect(st.near_low || st.bias === 'BELOW' || st.bias === 'INSIDE').toBe(true);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, minutes);
    setup = updateSetupSticky(setup, st, minutes);
    if (st.near_low) {
      expect(['CONTINUATION', 'PULLBACK', 'BREAKOUT', 'NONE'].includes(setup.kind)).toBe(true);
      expect(setup.kind).not.toMatch(/FADE|FAILED_BREAK/);
      if (setup.status === 'ARMED' && setup.side === 'BUY') {
        const bounce = bar10(2001.2, 2002.5, 2000.6, 2002.4);
        const entry = decideEntryFromSetup(setup, bounce, minutes);
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

  it('never FADE SELL at swing high into a rally — BUY with flow or wait 10s move', () => {
    const minutes = rangeMinutes();
    const nearHigh = buildStructure({ minutes, mid: 2009.2 });
    expect(nearHigh.near_high).toBe(true);
    let setup = emptySetup();
    setup = updateSetupSticky(setup, nearHigh, minutes);
    setup = updateSetupSticky(setup, nearHigh, minutes);
    expect(setup.kind).not.toMatch(/FADE|FAILED_BREAK/);
    // If armed at tip without UP flow, must be SELL-with-dump or NONE — not FADE book
    if (setup.status === 'ARMED') {
      expect(setup.playbook).not.toBe('FADE');
    }
    // Forced FADE BUY at tip must still be blocked while glued high
    const tipFadeBuy = {
      ...setup,
      kind: 'FADE' as const,
      side: 'BUY' as const,
      status: 'ARMED' as const,
      playbook: 'FADE' as const,
      swing_high: nearHigh.swing_high,
      swing_low: nearHigh.swing_low,
    };
    expect(decideEntryFromSetup(tipFadeBuy, bar10(2009, 2009.5, 2008.8, 2009.3), minutes)).toBeNull();
  });

  it('rally climb arms BUY CONTINUATION — never FADE SELL into live UP flow', () => {
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
      expect(setup.reason).toMatch(/stale high|rally|no counter-trend|mid swing|impulse|wait 10s|flow/i);
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

  it('decideEntryFromTenSecMove trades strong 10s when not against flow', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2005 });
    expect(st.ready).toBe(true);
    const buyBar = bar10(2004.5, 2006.2, 2004.4, 2006.0);
    const buy = decideEntryFromTenSecMove(st, buyBar, minutes);
    expect(buy?.direction).toBe('BUY');
    expect(buy?.setup).toBe('CONTINUATION');
    const sellBar = bar10(2005.5, 2005.6, 2003.8, 2004.0);
    const sell = decideEntryFromTenSecMove(st, sellBar, minutes);
    expect(sell?.direction).toBe('SELL');
  });

  it('decideEntryFromTenSecMove still refuses BUY into live dump flow', () => {
    const upBars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      upBars.push(candle(2000, 2002, 1998, 2000));
    }
    for (let i = 0; i < 5; i++) {
      const o = 2000 + i * 1.1;
      upBars.push(candle(o, o + 1.2, o - 0.2, o + 1.0));
    }
    // then dump
    for (let i = 0; i < 6; i++) {
      const o = 2005 - i * 1.0;
      upBars.push(candle(o, o + 0.2, o - 1.2, o - 0.9));
    }
    expect(priceFlowBias(upBars)).toBe('DOWN');
    const st = buildStructure({ minutes: upBars, mid: upBars[upBars.length - 1]!.close });
    const greenBlip = bar10(2001, 2002, 2000.8, 2001.8);
    expect(decideEntryFromTenSecMove(st, greenBlip, upBars)).toBeNull();
  });

  it('decideEntryFromTenSecMove refuses weak tip-park BUY at swing high', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2009.2 });
    expect(st.near_high).toBe(true);
    const tip = bar10(2008.8, 2009.6, 2008.7, 2009.4);
    expect(decideEntryFromTenSecMove(st, tip, minutes)).toBeNull();
  });

  it('strong Gold uptrend arms BUY — never SELL against the climb (chart class)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) {
      const o = 4395 + i * 0.55;
      bars.push(candle(o, o + 0.8, o - 0.2, o + 0.5));
    }
    expect(priceFlowBias(bars)).toBe('UP');
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.side).toBe('BUY');
    expect(setup.kind).not.toMatch(/FADE|FAILED_BREAK/);
    const redAgainst = bar10(4405, 4405.2, 4404.2, 4404.3);
    expect(decideEntryFromTenSecMove(st, redAgainst, bars)).toBeNull();
    const greenWith = bar10(4405, 4406.2, 4404.9, 4406.0);
    const entry =
      decideEntryFromSetup(setup, greenWith, bars) ||
      decideEntryFromTenSecMove(st, greenWith, bars);
    expect(entry?.direction).toBe('BUY');
  });

  it('never BUY into a dump — green 10s blip mid-dump is blocked', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) {
      bars.push(candle(4436, 4438, 4434, 4436));
    }
    for (let i = 0; i < 8; i++) {
      const o = 4436 - i * 0.55;
      bars.push(candle(o, o + 0.25, o - 0.7, o - 0.5));
    }
    expect(priceFlowBias(bars)).toBe('DOWN');
    const st = buildStructure({ minutes: bars, mid: bars[bars.length - 1]!.close });
    const greenBlip = bar10(4433.5, 4434.3, 4433.4, 4434.1);
    expect(decideEntryFromTenSecMove(st, greenBlip, bars)).toBeNull();
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
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.side).not.toBe('BUY');
  });
});
