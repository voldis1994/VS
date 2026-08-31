import { describe, expect, it } from 'vitest';
import {
  allowedSidesFromZones,
  buildZonesFromMinutes,
  nearRealZoneEdge,
  regimeConfirmedByZones,
  regimeForEntry,
} from './structureZones.js';
import type { CapitalPriceCandle } from './capitalCom.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

/** Flat range ~2000–2010 for ~15 minutes, alternating closes (no trend persistence). */
function rangeBook(lastMid = 2005) {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 14; i++) {
    const up = i % 2 === 0;
    const o = up ? 2003 : 2007;
    const c = up ? 2006.5 : 2003.5;
    bars.push(candle(o, 2009.5, 2000.5, c));
  }
  // compressed last bar inside / at edge
  bars.push(candle(lastMid - 0.2, lastMid + 0.3, lastMid - 0.3, lastMid));
  return buildZonesFromMinutes(bars, lastMid);
}

describe('structureZones', () => {
  it('needs enough minute bars before ready', () => {
    const z = buildZonesFromMinutes([candle(1, 2, 0.5, 1.5)], 1.5);
    expect(z.ready).toBe(false);
  });

  it('builds RANGE structure in a quiet band', () => {
    const z = rangeBook(2005);
    expect(z.ready).toBe(true);
    expect(z.structure).toBe('RANGE');
    expect(z.high).toBeGreaterThan(z.low);
  });

  it('marks near high/low for FADE edges', () => {
    const nearHigh = rangeBook(2009.2);
    expect(nearRealZoneEdge(nearHigh, 'high')).toBe(true);
    const nearLow = rangeBook(2001);
    expect(nearRealZoneEdge(nearLow, 'low')).toBe(true);
    const mid = rangeBook(2005);
    expect(nearRealZoneEdge(mid, 'high')).toBe(false);
    expect(nearRealZoneEdge(mid, 'low')).toBe(false);
  });

  it('blocks TREND_UP entry when minute structure is TREND_DOWN', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      const base = 2020 - i * 1.2;
      bars.push(candle(base, base + 0.4, base - 1.5, base - 1));
    }
    const z = buildZonesFromMinutes(bars, bars[bars.length - 1]!.close);
    expect(z.structure === 'TREND_DOWN' || z.structure === 'BREAKOUT_DOWN').toBe(true);
    const gate = regimeConfirmedByZones('TREND_UP', z);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/BLOCK/);
  });

  it('allows RANGE FADE only at real zone edge', () => {
    const mid = rangeBook(2005);
    expect(regimeConfirmedByZones('RANGE', mid).ok).toBe(false);
    const edge = rangeBook(2009.3);
    expect(regimeConfirmedByZones('RANGE', edge).ok).toBe(true);
  });

  it('blocks FADE when minute structure is trending', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      const base = 1990 + i * 1.5;
      bars.push(candle(base, base + 1.8, base - 0.3, base + 1.2));
    }
    const z = buildZonesFromMinutes(bars, bars[bars.length - 1]!.close);
    expect(['TREND_UP', 'BREAKOUT_UP'].includes(z.structure)).toBe(true);
    expect(regimeConfirmedByZones('RANGE', z).ok).toBe(false);
  });

  it('waits while zones seeding', () => {
    const gate = regimeConfirmedByZones('TREND_UP', buildZonesFromMinutes([], null));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/ZONES/);
  });

  it('zone-leads entry when 10s still RANGE on a TREND move', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      const base = 1990 + i * 1.5;
      bars.push(candle(base, base + 1.8, base - 0.3, base + 1.2));
    }
    const z = buildZonesFromMinutes(bars, bars[bars.length - 1]!.close);
    expect(['TREND_UP', 'BREAKOUT_UP'].includes(z.structure)).toBe(true);
    const led = regimeForEntry('RANGE', z);
    expect(led.led).toBe(true);
    expect(led.regime === 'TREND_UP' || led.regime === 'BREAKOUT_UP').toBe(true);
  });

  it('allowedSidesFromZones: trend = one side; range mid = none; edge = fade', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      const base = 1990 + i * 1.5;
      bars.push(candle(base, base + 1.8, base - 0.3, base + 1.2));
    }
    const up = buildZonesFromMinutes(bars, bars[bars.length - 1]!.close);
    const upSides = allowedSidesFromZones(up);
    expect(upSides.buy).toBe(true);
    expect(upSides.sell).toBe(false);

    const mid = rangeBook(2005);
    const midSides = allowedSidesFromZones(mid);
    expect(midSides.buy).toBe(false);
    expect(midSides.sell).toBe(false);
    expect(midSides.playbook).toBe('WAIT');

    const edge = rangeBook(2009.3);
    const edgeSides = allowedSidesFromZones(edge);
    expect(edgeSides.sell).toBe(true);
    expect(edgeSides.playbook).toBe('FADE');
  });

  it('does not invent TREND from one green breakout candle / mid bias', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      const up = i % 2 === 0;
      bars.push(candle(up ? 2003 : 2007, 2009.5, 2000.5, up ? 2006.5 : 2003.5));
    }
    // One green close above prior H — no multi-bar persistence
    bars.push(candle(2008, 2012, 2007.5, 2011.5));
    const z = buildZonesFromMinutes(bars, 2011.5);
    expect(z.ready).toBe(true);
    expect(z.structure).not.toBe('BREAKOUT_UP');
    expect(z.structure).not.toBe('TREND_UP');
    const sides = allowedSidesFromZones(z);
    // Mid-bias alone must not unlock BUY
    if (z.structure === 'RANGE' || z.structure === 'UNKNOWN') {
      expect(sides.buy).toBe(z.near_low);
      expect(sides.sell).toBe(z.near_high);
    }
  });

  it('requires ≥12 minute bars (not one candle zones)', () => {
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 11; i++) {
      bars.push(candle(2000 + i, 2001 + i, 1999 + i, 2000.5 + i));
    }
    expect(buildZonesFromMinutes(bars, 2010).ready).toBe(false);
    bars.push(candle(2011, 2012, 2010, 2011.5));
    expect(buildZonesFromMinutes(bars, 2011.5).ready).toBe(true);
  });

  it('FAILED_BREAKOUT needs multi-minute base+probe — not 3 short bars', () => {
    // Too few bars → no failed label
    const tiny: CapitalPriceCandle[] = [];
    for (let i = 0; i < 10; i++) {
      tiny.push(candle(2003, 2009.5, 2000.5, 2005));
    }
    tiny.push(candle(2008, 2015, 2007, 2014)); // poke high
    tiny.push(candle(2010, 2012, 2004, 2005)); // back inside red
    expect(buildZonesFromMinutes(tiny, 2005).structure).not.toBe('FAILED_BREAKOUT_UP');

    // ≥12 base + 6 probe with clear fail-up
    const bars: CapitalPriceCandle[] = [];
    for (let i = 0; i < 14; i++) {
      const up = i % 2 === 0;
      bars.push(candle(up ? 2003 : 2007, 2009.5, 2000.5, up ? 2006.5 : 2003.5));
    }
    // probe: break above then return inside on last (red)
    bars.push(candle(2008, 2011, 2007, 2010));
    bars.push(candle(2010, 2014, 2009, 2013)); // close above prior ~2009.5
    bars.push(candle(2012, 2015, 2011, 2014));
    bars.push(candle(2013, 2014, 2008, 2009));
    bars.push(candle(2009, 2010, 2005, 2006));
    bars.push(candle(2006, 2008, 2004, 2005)); // back inside, red
    const z = buildZonesFromMinutes(bars, 2005);
    expect(z.structure).toBe('FAILED_BREAKOUT_UP');
    const sides = allowedSidesFromZones(z);
    expect(sides.sell).toBe(true);
    expect(sides.buy).toBe(false);
    expect(sides.playbook).toBe('FADE');
  });
});
