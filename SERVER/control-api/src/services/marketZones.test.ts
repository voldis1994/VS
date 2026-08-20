import { describe, expect, it } from 'vitest';
import {
  buildMarketZones,
  decideZoneManageExit,
  partialCloseSize,
  zoneAllowsEntry,
  zoneHalfWidth,
} from './marketZones.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(o: number, h: number, l: number, c: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open: o, high: h, low: l, close: c, ticks: 10 };
}

/** Explicit swing low then bounce — demand at ~100. */
function demandSetup(): TenSecBar[] {
  return [
    bar(102, 103, 101.5, 102.5, 0),
    bar(102.5, 103.2, 102, 102.8, 1),
    bar(102.8, 103, 100.0, 100.4, 2), // swing low 100
    bar(100.4, 101.2, 100.1, 101.0, 3),
    bar(101.0, 101.5, 100.8, 101.2, 4),
    bar(101.2, 101.8, 100.9, 100.5, 5), // back near demand
    bar(100.5, 100.8, 100.0, 100.3, 6), // touch demand
  ];
}

/** Explicit swing high — supply at ~110. */
function supplySetup(): TenSecBar[] {
  return [
    bar(105, 106, 104.5, 105.5, 0),
    bar(105.5, 107, 105, 106.5, 1),
    bar(106.5, 110.0, 106.2, 109.5, 2), // swing high 110
    bar(109.5, 109.8, 108, 108.5, 3),
    bar(108.5, 109, 107.5, 108, 4),
    bar(108, 109.5, 107.8, 109.2, 5),
    bar(109.2, 110.2, 109, 109.8, 6), // at supply
  ];
}

describe('marketZones', () => {
  it('builds demand from swing lows', () => {
    const z = buildMarketZones(demandSetup());
    expect(z.demand.length).toBeGreaterThan(0);
    expect(zoneHalfWidth(4400)).toBeGreaterThanOrEqual(0.8);
  });

  it('BUY pullback allowed on demand touch; mid-air blocked', () => {
    const bars = demandSetup();
    const last = bars[bars.length - 1]!;
    const zones = buildMarketZones(bars);
    const ok = zoneAllowsEntry({
      direction: 'BUY',
      setup: 'PULLBACK',
      bar: last,
      zones,
    });
    expect(ok.ok).toBe(true);

    const midAir = bar(112, 113, 111.5, 112.5, 9);
    const fail = zoneAllowsEntry({
      direction: 'BUY',
      setup: 'PULLBACK',
      bar: midAir,
      zones: buildMarketZones([...bars, midAir]),
    });
    expect(fail.ok).toBe(false);
  });

  it('partialCloseSize halves 0.1 → 0.05', () => {
    expect(partialCloseSize(0.1)).toBe(0.05);
    expect(partialCloseSize(0.01)).toBe(0);
  });

  it('BUY hits first supply → FULL take-profit', () => {
    const bars = supplySetup();
    const zones = buildMarketZones(bars);
    expect(zones.supply.length).toBeGreaterThan(0);
    const entry = 105.5;
    const first = zones.supply.sort((a, b) => a.pivot - b.pivot)[0]!;
    const d = decideZoneManageExit({
      side: 'BUY',
      entry,
      mid: first.lo + 0.05,
      bars,
      zones,
      partial_done: false,
      upl: 3,
    });
    expect(d.action).toBe('FULL');
    expect(d.close_fraction).toBe(1);
  });

  it('BUY adverse reverse into demand → FULL', () => {
    const bars = demandSetup();
    const zones = buildMarketZones(bars);
    const entry = 100.3;
    const d = decideZoneManageExit({
      side: 'BUY',
      entry,
      mid: 100.05,
      bars: [...bars, bar(100.2, 100.25, 99.9, 100.0, 7)],
      zones,
      partial_done: false,
      upl: -1,
    });
    expect(d.action).toBe('FULL');
  });
});
