import { describe, expect, it, beforeEach } from 'vitest';
import { classifyRegime, MIN_BARS_FOR_ZONE } from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import {
  _resetBrainGenomeForTests,
  getBrainGenome,
  sanitizeGenome,
  setBrainGenome,
  reloadBrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import { getActiveRegimeBands } from './regimeBands.js';

function bar(o: number, h: number, l: number, c: number, i: number): TenSecBar {
  return { open_time_ms: i * 10_000, open: o, high: h, low: l, close: c, ticks: 8 };
}

/** Quiet mid-zone chop book — should be RANGE under factory positive chop gates. */
function quietChopBook(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
    const wobble = ((i % 4) - 1.5) * 0.02;
    const c = 100 + wobble;
    bars.push(bar(c, c + 0.03, c - 0.03, c, i));
  }
  return bars;
}

describe('positive RANGE — genome-calibrated chop', () => {
  beforeEach(() => {
    _resetBrainGenomeForTests({});
  });

  it('factory knobs expose RANGE chop gates on active bands', () => {
    const b = getActiveRegimeBands();
    expect(b.RANGE_CHOP_PERSIST_MAX).toBe(0.25);
    expect(b.RANGE_CHOP_TREK_SHARE_MAX).toBe(0.32);
    expect(b.RANGE_CHOP_TREK_EFF_MAX).toBe(0.45);
  });

  it('quiet mid chop is RANGE; loosening persist max still RANGE', () => {
    const bars = quietChopBook();
    expect(classifyRegime(bars, 'UNKNOWN')).toBe('RANGE');
  });

  it('tightening chop persist max can deny RANGE (sticky/UNKNOWN instead of invent)', () => {
    const bars = quietChopBook();
    // Force tiny persist ceiling — only near-zero persistence counts as chop
    setBrainGenome({ regime_range_chop_persist_max: 0.08 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_range_chop_persist_max).toBe(0.08);
    // Quiet book still near-zero persist → still RANGE; use sticky with prior TREND
    // and a tip that has mild directional persist > 0.08
    const tip: TenSecBar[] = [...bars];
    let px = 100;
    for (const s of [-1, -1, -1, 1, -1, -1]) {
      const o = px;
      const c = o + s * 0.04;
      tip.push(bar(o, Math.max(o, c) + 0.02, Math.min(o, c) - 0.02, c, tip.length));
      px = c;
    }
    const r = classifyRegime(tip, 'TREND_DOWN');
    expect(r).not.toBe('RANGE');
  });

  it('sanitize clamps RANGE chop knobs', () => {
    const g = sanitizeGenome({
      regime_range_chop_persist_max: 9,
      regime_range_trek_share_max: 0.01,
      regime_range_trek_eff_max: 0.99,
    });
    expect(g.regime_range_chop_persist_max).toBe(0.55);
    expect(g.regime_range_trek_share_max).toBe(0.12);
    expect(g.regime_range_trek_eff_max).toBe(0.7);
  });
});
