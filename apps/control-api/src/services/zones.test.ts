import { describe, expect, it } from 'vitest';
import { buildScalpZone, evaluateZoneEntry } from './zones.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(o: number, h: number, l: number, c: number, i: number): TenSecBar {
  return { open_time_ms: i * 10_000, open: o, high: h, low: l, close: c, ticks: 8 };
}

describe('buildScalpZone 10s', () => {
  it('forms a BOX from quiet consolidation', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 12; i++) {
      const mid = 4500 + (i % 3) * 0.4;
      bars.push(bar(mid, mid + 1.2, mid - 1.2, mid + 0.2, i));
    }
    const z = buildScalpZone(bars);
    expect(z).not.toBeNull();
    expect(z!.width_pct).toBeGreaterThan(0.0004);
    expect(z!.detail).toMatch(/BOX|DEMAND|SUPPLY/);
  });

  it('rejects runaway range as non-zone', () => {
    const bars = [
      bar(4500, 4510, 4490, 4505, 0),
      bar(4505, 4520, 4500, 4518, 1),
      bar(4518, 4540, 4515, 4535, 2),
      bar(4535, 4560, 4530, 4555, 3),
      bar(4555, 4580, 4550, 4575, 4),
      bar(4575, 4600, 4570, 4595, 5),
      bar(4595, 4620, 4590, 4615, 6),
      bar(4615, 4640, 4610, 4635, 7),
    ];
    expect(buildScalpZone(bars)).toBeNull();
  });
});

describe('evaluateZoneEntry', () => {
  it('allows BUY breakout through zone high', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 10; i++) {
      bars.push(bar(4500, 4503, 4498, 4501, i));
    }
    const z = buildScalpZone(bars)!;
    const breakout = bar(z.high - 0.5, z.high + 2, z.high - 1, z.high + 1.2, 11);
    const v = evaluateZoneEntry('BUY', breakout, z, bars);
    expect(v.ok).toBe(true);
    expect(v.setup).toBe('BREAKOUT');
  });

  it('waits when price is mid-box with no touch', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 10; i++) {
      bars.push(bar(4500, 4504, 4497, 4501, i));
    }
    const z = buildScalpZone(bars)!;
    const mid = bar(z.mid, z.mid + 0.3, z.mid - 0.3, z.mid + 0.1, 11);
    const v = evaluateZoneEntry('BUY', mid, z, bars);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/ZONE wait/);
  });
});
