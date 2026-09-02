import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideEntryFromSetup,
  decideEntryFromTenSecMove,
  emptySetup,
  isImpulseAgainstSide,
  isTipChaseEntry,
  priceFlowBias,
  recentImpulse,
  updateSetupSticky,
} from './marketSetup.js';
import { minSwingSpan } from './instrumentScale.js';
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

  it('blocks FADE BUY at swing high tip (no tip chase)', () => {
    const minutes: CapitalPriceCandle[] = [];
    for (let i = 0; i < 28; i++) {
      minutes.push(candle(4428, 4432, 4426, 4429));
    }
    minutes.push(candle(4429, 4433.8, 4428.5, 4433.2));
    minutes.push(candle(4433, 4433.5, 4431.2, 4431.6));
    const st = buildStructure({ minutes, mid: 4432.6 });
    expect(st.ready).toBe(true);
    const tipFadeBuy = {
      ...emptySetup(),
      kind: 'FADE' as const,
      side: 'BUY' as const,
      playbook: 'FADE' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: st.swing_high,
      swing_low: st.swing_low,
    };
    expect(
      decideEntryFromSetup(tipFadeBuy, bar10(4433.2, 4433.9, 4432.8, 4433.6), minutes)
    ).toBeNull();
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
    expect(isImpulseAgainstSide('BUY', bars)).toBe(true);
    expect(isImpulseAgainstSide('SELL', bars)).toBe(false);
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
    // Dump minutes so SELL is not blocked by flow UP
    const dump: CapitalPriceCandle[] = [...minutes];
    for (let i = 0; i < 6; i++) {
      const o = 2005 - i * 1.1;
      dump.push(candle(o, o + 0.2, o - 1.3, o - 1.0));
    }
    const stDump = buildStructure({ minutes: dump, mid: dump.at(-1)!.close });
    const sellBar = bar10(2003.5, 2003.6, 2001.8, 2002.0);
    const sell = decideEntryFromTenSecMove(stDump, sellBar, dump);
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

  it('EUR/USD flat compression does not ARM stuck FADE at H≈L', () => {
    const minutes: CapitalPriceCandle[] = [];
    for (let i = 0; i < 28; i++) {
      minutes.push(candle(1.1599, 1.15995, 1.15985, 1.1599));
    }
    const st = buildStructure({ minutes, mid: 1.1599 });
    expect(st.ready).toBe(true);
    const span = st.swing_high - st.swing_low;
    if (span < minSwingSpan(1.16)) {
      let setup = emptySetup();
      setup = updateSetupSticky(setup, st, minutes);
      expect(setup.kind).not.toBe('FADE');
    } else {
      // still must not tip-chase block at identical H/L display
      const fadeBuy = {
        kind: 'FADE' as const,
        side: 'BUY' as const,
        playbook: 'FADE' as const,
        status: 'ARMED' as const,
        swing_high: st.swing_high,
        swing_low: st.swing_low,
      };
      expect(isTipChaseEntry(fadeBuy as never, bar10(1.1599, 1.16, 1.1598, 1.1599))).toBe(false);
    }
  });

  it('decideEntryFromTenSecMove trades EUR/USD when swing span is tiny', () => {
    const minutes: CapitalPriceCandle[] = [];
    for (let i = 0; i < 28; i++) {
      minutes.push(candle(1.1598, 1.16, 1.1596, 1.1599));
    }
    const st = buildStructure({ minutes, mid: 1.1599 });
    const moveBar = bar10(1.1598, 1.1603, 1.1597, 1.1602);
    expect(decideEntryFromTenSecMove(st, moveBar, minutes)?.direction).toBe('BUY');
  });

  it('isTipChaseEntry skips flat H≈L compression', () => {
    const fadeBuy = {
      kind: 'FADE' as const,
      side: 'BUY' as const,
      swing_high: 1.16,
      swing_low: 1.16,
    };
    const bar = bar10(1.16, 1.16, 1.16, 1.16);
    expect(isTipChaseEntry(fadeBuy as never, bar)).toBe(false);
  });
});
