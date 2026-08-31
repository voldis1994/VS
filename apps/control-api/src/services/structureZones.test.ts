import { describe, expect, it } from 'vitest';
import {
  buildZonesFromMinutes,
  nearRealZoneEdge,
  regimeConfirmedByZones,
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
});
