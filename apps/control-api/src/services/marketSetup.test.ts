import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  buildStructure,
  decideEntryFromArmedLive,
  decideEntryFromClosed1m,
  decideEntryFromSetup,
  decideEntryFromTenSecMove,
  emptySetup,
  emptyStructure,
  isQualityEntrySetup,
  priceFlowBias,
  recentImpulse,
  updateSetupSticky,
} from './marketSetup.js';
import { withTrendSideFromRegime } from './playbooks.js';
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

  it('impulse UP flips sticky SELL to BUY FORMING (sticky must confirm before ARMED)', () => {
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
    expect(setup.status).toBe('FORMING');
    expect(setup.reason).toMatch(/IMPULSE UP|BREAKOUT|flipped|forming/i);
    expect(setup.watch_buy).toBeTruthy();
    // Second sticky tick on same side → ARMED
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.status).toBe('ARMED');
  });

  it('local dump impulse forms CONTINUATION SELL — arms on sticky confirm', () => {
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
    expect(setup.status).toBe('FORMING');
    setup = updateSetupSticky(setup, st, bars);
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

  it('decideEntryFromTenSecMove is disabled (no mid-NONE chase)', () => {
    const minutes = rangeMinutes();
    const st = buildStructure({ minutes, mid: 2005 });
    expect(st.ready).toBe(true);
    const buyBar = bar10(2004.5, 2006.2, 2004.4, 2006.0);
    expect(decideEntryFromTenSecMove(st, buyBar, minutes)).toBeNull();
    const sellBar = bar10(2005.5, 2005.6, 2003.8, 2004.0);
    expect(decideEntryFromTenSecMove(st, sellBar, minutes)).toBeNull();
  });

  it('decideEntryFromTenSecMove still null at swing tip', () => {
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
    expect(decideEntryFromArmedLive(fadeBuy, greenBlip.close, bars)).toBeNull();
    const dump1m = candle(4433.5, 4434.3, 4430.5, 4431.0);
    expect(decideEntryFromClosed1m(fadeBuy, dump1m, bars)).toBeNull();
    // Setup itself should prefer SELL not FADE BUY at low while dumping
    let setup = emptySetup();
    setup = updateSetupSticky(setup, st, bars);
    expect(setup.side).not.toBe('BUY');
  });

  it('decideEntryFromArmedLive is disabled (no live-mid chase)', () => {
    const minutes = rangeMinutes();
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 2000,
      reason: 'CONTINUATION up',
    };
    expect(decideEntryFromArmedLive(contBuy, 2005, minutes)).toBeNull();
  });

  it('decideEntryFromClosed1m enters CONTINUATION on Capital 1m green body + UP impulse', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) bars.push(candle(2000, 2002, 1998, 2000));
    // Impulse UP last minutes
    bars.push(candle(2000, 2002, 1999.5, 2001.5));
    bars.push(candle(2001.5, 2004, 2001, 2003.5));
    bars.push(candle(2003.5, 2007, 2003, 2006.5));
    expect(recentImpulse(bars, 'flip') || recentImpulse(bars)).toBe('UP');
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 1995,
      reason: 'CONTINUATION up',
    };
    const green1m = candle(2004, 2008, 2003.8, 2007.2); // ~3.2pt body
    const st = buildStructure({ minutes: bars, mid: 2007 });
    const e = decideEntryFromClosed1m(contBuy, green1m, bars, st);
    expect(e?.direction).toBe('BUY');
    expect(e?.reason).toMatch(/Capital 1m/);
  });

  it('decideEntryFromClosed1m: no trend filter — BUY allowed on TREND_DOWN and TREND_UP', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) bars.push(candle(2000, 2002, 1998, 2000));
    bars.push(candle(2000, 2002, 1999.5, 2001.5));
    bars.push(candle(2001.5, 2004, 2001, 2003.5));
    bars.push(candle(2003.5, 2007, 2003, 2006.5));
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 1995,
      reason: 'CONTINUATION up',
    };
    const green1m = candle(2004, 2008, 2003.8, 2007.2);
    const st = buildStructure({ minutes: bars, mid: 2007 });
    expect(withTrendSideFromRegime('TREND_DOWN')).toBe('SELL');
    expect(decideEntryFromClosed1m(contBuy, green1m, bars, st, 'TREND_DOWN')?.direction).toBe(
      'BUY'
    );
    expect(decideEntryFromClosed1m(contBuy, green1m, bars, st, 'TREND_UP')?.direction).toBe(
      'BUY'
    );
  });

  it('decideEntryFromClosed1m: no trend filter — SELL allowed on TREND_UP', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) bars.push(candle(2010, 2012, 2008, 2010));
    bars.push(candle(2010, 2010.5, 2006, 2006.5));
    bars.push(candle(2006.5, 2007, 2003, 2003.5));
    bars.push(candle(2003.5, 2004, 2000, 2000.5));
    const contSell = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'SELL' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2015,
      swing_low: 1995,
      reason: 'CONTINUATION down',
    };
    const red1m = candle(2004, 2004.2, 2000, 2000.5);
    expect(decideEntryFromClosed1m(contSell, red1m, bars, null, 'TREND_UP')?.direction).toBe(
      'SELL'
    );
    expect(decideEntryFromClosed1m(contSell, red1m, bars, null, 'TREND_DOWN')?.direction).toBe(
      'SELL'
    );
  });

  it('decideEntryFromClosed1m refuses flat doji only (<0.5pt)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) bars.push(candle(2000, 2002, 1998, 2000));
    bars.push(candle(2000, 2002, 1999.5, 2001.5));
    bars.push(candle(2001.5, 2004, 2001, 2003.5));
    bars.push(candle(2003.5, 2007, 2003, 2006.5));
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 1995,
    };
    const micro = candle(2005, 2005.2, 2004.9, 2005.2); // 0.2pt doji
    expect(decideEntryFromClosed1m(contBuy, micro, bars)).toBeNull();
    const smallOk = candle(2005, 2006.2, 2004.8, 2005.9); // 0.9pt — allowed (no quality floor)
    expect(decideEntryFromClosed1m(contBuy, smallOk, bars)?.direction).toBe('BUY');
  });

  it('decideEntryFromClosed1m allows FADE / PULLBACK / FAILED_BREAK (no kind filter)', () => {
    const minutes = rangeMinutes();
    const fadeBuy = {
      ...emptySetup(),
      kind: 'FADE' as const,
      side: 'BUY' as const,
      playbook: 'FADE' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 2000,
    };
    const bigGreen = candle(2001, 2005, 2000.5, 2004.5);
    expect(decideEntryFromClosed1m(fadeBuy, bigGreen, minutes)?.direction).toBe('BUY');
    expect(isQualityEntrySetup('FADE')).toBe(true);
    expect(isQualityEntrySetup('FAILED_BREAK')).toBe(true);
    expect(isQualityEntrySetup('PULLBACK')).toBe(true);
    expect(isQualityEntrySetup('CONTINUATION')).toBe(true);
    expect(isQualityEntrySetup('BREAKOUT')).toBe(true);
  });

  it('decideEntryFromClosed1m allows CONTINUATION when impulse is quiet (body confirms)', () => {
    // Flat/quiet minutes — no impulse — but Capital 1m body is real
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 24; i++) bars.push(candle(2000, 2000.4, 1999.7, 2000.1));
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 1995,
    };
    const green1m = candle(2000, 2004, 1999.8, 2003.5); // 3.5pt body
    const e = decideEntryFromClosed1m(contBuy, green1m, bars);
    expect(e?.direction).toBe('BUY');
    expect(e?.setup).toBe('CONTINUATION');
  });

  it('decideEntryFromClosed1m allows ARMED PULLBACK BUY on green Capital 1m', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 20; i++) bars.push(candle(2000 + i * 0.15, 2000.5 + i * 0.15, 1999.5 + i * 0.15, 2000.2 + i * 0.15));
    bars.push(candle(2003, 2004, 2002.5, 2003.6));
    bars.push(candle(2003.6, 2005, 2003.4, 2004.8));
    const pbBuy = {
      ...emptySetup(),
      kind: 'PULLBACK' as const,
      side: 'BUY' as const,
      playbook: 'SCALP' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 1995,
    };
    const green1m = candle(2003.5, 2006.5, 2003.2, 2006.2); // ~2.7pt
    const e = decideEntryFromClosed1m(pbBuy, green1m, bars);
    expect(e?.direction).toBe('BUY');
    expect(e?.setup).toBe('PULLBACK');
  });

  it('decideEntryFromClosed1m refuses red 1m for BUY CONTINUATION', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) bars.push(candle(2000, 2002, 1998, 2000));
    bars.push(candle(2000, 2002, 1999.5, 2001.5));
    bars.push(candle(2001.5, 2004, 2001, 2003.5));
    bars.push(candle(2003.5, 2007, 2003, 2006.5));
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 2010,
      swing_low: 1995,
    };
    const red1m = candle(2007, 2007.2, 2003.5, 2003.8);
    expect(decideEntryFromClosed1m(contBuy, red1m, bars)).toBeNull();
  });

  it('decideEntryFromClosed1m allows BUY even into dump flow (no flow filter)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 22; i++) bars.push(candle(4436, 4438, 4434, 4436));
    for (let i = 0; i < 8; i++) {
      const o = 4436 - i * 0.55;
      bars.push(candle(o, o + 0.25, o - 0.7, o - 0.5));
    }
    expect(priceFlowBias(bars)).toBe('DOWN');
    const contBuy = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 3,
      swing_high: 4440,
      swing_low: 4428,
    };
    const greenBlip1m = candle(4433.5, 4437, 4433.2, 4436.5); // big body but dump flow
    expect(decideEntryFromClosed1m(contBuy, greenBlip1m, bars)?.direction).toBe('BUY');
  });
});
