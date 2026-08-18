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

  it('noteMarketMid yields change on second tick', () => {
    expect(noteMarketMid('EURUSD', 1.1)).toBeNull();
    const ch = noteMarketMid('EURUSD', 1.11);
    expect(ch).toBeCloseTo(0.01);
  });
});
