import { describe, expect, it } from 'vitest';
import {
  detectStructureReversalExit,
  thesisAlive5m,
} from './structureReversalExit.js';
import type { StructureBar } from './marketStructure.js';

function bar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number
): StructureBar {
  return {
    open_time_ms: i * 300_000,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks: 10,
    provenance: 'REAL',
  };
}

/** Uptrend HH/HL series */
function bullSeries(n = 12): StructureBar[] {
  const out: StructureBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = px + (i % 2 === 0 ? 1.2 : 0.6);
    const h = Math.max(o, c) + 0.3;
    const l = Math.min(o, c) - 0.2;
    out.push(bar(i, o, h, l, c));
    px = c;
  }
  return out;
}

describe('structureReversalExit', () => {
  it('thesisAlive5m true on HH/HL bull series', () => {
    const bars = bullSeries();
    const t = thesisAlive5m('BUY', bars);
    expect(t.alive).toBe(true);
  });

  it('normal retrace with alive thesis → HOLD (no exit)', () => {
    const bars = bullSeries();
    const entry = 100;
    const price = entry + 2; // small retrace from peak but thesis intact
    const r = detectStructureReversalExit({
      side: 'BUY',
      price,
      entry,
      mfe: 5,
      bars5m: bars,
      bars1m: bars.slice(-6),
      bars10s: [],
      atr: 2,
      continuationSameSide: true,
    });
    expect(r.exit).toBe(false);
    expect(r.thesisAlive).toBe(true);
  });

  it('TargetEnd when structure target hit and continuation ended', () => {
    const bars = bullSeries();
    const r = detectStructureReversalExit({
      side: 'BUY',
      price: 110,
      entry: 100,
      mfe: 10,
      bars5m: bars,
      atr: 2,
      structure_target: 8,
      continuationSameSide: false,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toMatch(/TargetEnd/);
  });
});
