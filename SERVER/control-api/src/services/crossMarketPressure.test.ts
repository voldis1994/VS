import { describe, expect, it, beforeEach } from 'vitest';
import {
  computeCrossMarketPressure,
  noteMarketMid,
  relatedSearchNeedles,
  resetCrossMarketForTests,
} from './crossMarketPressure.js';

describe('cross-market pressure on selected epic', () => {
  beforeEach(() => resetCrossMarketForTests());

  it('gold needles include USD/oil/silver/index — not only gold feeds', () => {
    const n = relatedSearchNeedles('XAUUSD', 'Gold');
    expect(n.join(' ')).toMatch(/XAG|SILVER/);
    expect(n.join(' ')).toMatch(/OIL|BRENT/);
    expect(n.join(' ')).toMatch(/EURUSD|DXY/);
    expect(n).not.toContain('XAU');
    expect(n).not.toContain('GOLD');
  });

  it('EURUSD gets FX cross-market needles', () => {
    const n = relatedSearchNeedles('EURUSD', 'EUR/USD');
    expect(n.join(' ')).toMatch(/US500|NAS/);
    expect(n.join(' ')).toMatch(/XAU|GOLD/);
  });

  it('US500 gets index cross-market needles', () => {
    const n = relatedSearchNeedles('US500', 'S&P 500');
    expect(n.length).toBeGreaterThan(4);
    expect(n.join(' ')).toMatch(/EURUSD|USDJPY/);
  });

  it('dollar up (EURUSD down) pressures against BUY gold', () => {
    const p = computeCrossMarketPressure({
      targetEpic: 'XAUUSD',
      targetName: 'Gold',
      side: 'BUY',
      related: [{ epic: 'EURUSD', mid: 1.08, change: -0.012 }],
    });
    expect(p.against).toBe(true);
    expect(p.side).toBe('BUY');
    expect(p.pressure).toBeLessThan(0);
    expect(p.asset_class).toBe('gold');
  });

  it('silver + oil up supports BUY gold', () => {
    const p = computeCrossMarketPressure({
      targetEpic: 'XAUUSD',
      targetName: 'Gold',
      side: 'BUY',
      related: [
        { epic: 'XAGUSD', display_name: 'Silver', mid: 30, change: 0.4 },
        { epic: 'OIL', display_name: 'Oil', mid: 80, change: 1.2 },
      ],
    });
    expect(p.against).toBe(false);
    expect(p.pressure).toBeGreaterThan(0);
  });

  it('US500 up supports BUY US100', () => {
    const p = computeCrossMarketPressure({
      targetEpic: 'US100',
      targetName: 'Nasdaq',
      side: 'BUY',
      related: [{ epic: 'US500', display_name: 'S&P', mid: 5500, change: 12 }],
    });
    expect(p.asset_class).toBe('index_us');
    expect(p.pressure).toBeGreaterThan(0);
  });

  it('noteMarketMid yields change on second tick', () => {
    expect(noteMarketMid('EURUSD', 1.1)).toBeNull();
    const ch = noteMarketMid('EURUSD', 1.11);
    expect(ch).toBeCloseTo(0.01);
  });
});
