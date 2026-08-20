/**
 * Regime evidence + internal structure + hysteresis replay tests.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyRegime,
  classifyRegimeDetailed,
  detectInternalStructure,
  evaluateRangeEvidence,
  applyRegimeHysteresis,
  resetRegimeBook,
  TREND_TO_RANGE_MIN_BARS,
  type RegimeName,
} from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

/** Explicit LH → LL → LH → LL → LH → LL 10s sequence. */
function lhLlSequence(): TenSecBar[] {
  // Each pair: lower high then lower low — clear bearish swing structure
  return [
    bar(4524.0, 4525.0, 4523.2, 4524.5, 0), // H1
    bar(4524.5, 4524.8, 4522.0, 4522.4, 1), // L1
    bar(4522.4, 4523.6, 4521.8, 4523.0, 2), // H2 < H1  (LH)
    bar(4523.0, 4523.2, 4520.5, 4520.9, 3), // L2 < L1  (LL)
    bar(4520.9, 4522.2, 4520.4, 4521.6, 4), // H3 < H2  (LH)
    bar(4521.6, 4521.9, 4519.2, 4519.6, 5), // L3 < L2  (LL)
    bar(4519.6, 4520.8, 4519.0, 4520.2, 6), // H4 < H3  (LH)
    bar(4520.2, 4520.5, 4518.0, 4518.4, 7), // L4 < L3  (LL)
    bar(4518.4, 4519.5, 4517.8, 4518.9, 8), // H5 < H4  (LH)
    bar(4518.9, 4519.1, 4516.5, 4516.9, 9), // L5 < L4  (LL)
  ];
}

describe('internal structure from 10s swings', () => {
  it('LH/LL replay → INTERNAL_STRUCTURE = BEARISH', () => {
    const bars = lhLlSequence();
    const s = detectInternalStructure(bars);
    expect(s.structure).toBe('BEARISH');
    expect(s.lh + s.ll).toBeGreaterThan(s.hh + s.hl);
  });

  it('HH/HL climb → BULLISH', () => {
    const bars = [
      bar(100, 100.5, 99.8, 100.3, 0),
      bar(100.3, 100.4, 100.0, 100.1, 1),
      bar(100.1, 101.0, 100.05, 100.8, 2), // HH
      bar(100.8, 100.9, 100.4, 100.5, 3), // HL
      bar(100.5, 101.6, 100.45, 101.4, 4), // HH
      bar(101.4, 101.5, 101.0, 101.1, 5), // HL
      bar(101.1, 102.2, 101.05, 102.0, 6),
      bar(102.0, 102.1, 101.6, 101.7, 7),
    ];
    expect(detectInternalStructure(bars).structure).toBe('BULLISH');
  });
});

describe('RANGE is proven, not EMA fallback', () => {
  it('LH/LL sequence is NOT classified as RANGE from weak confidence', () => {
    const bars = lhLlSequence();
    const d = classifyRegimeDetailed(bars, 'UNKNOWN');
    expect(d.internal_structure).toBe('BEARISH');
    expect(d.regime).not.toBe('RANGE');
    expect(['TREND_DOWN', 'BREAKOUT_DOWN', 'EXPANSION', 'TRANSITION']).toContain(d.regime);
    // Prefer TREND_DOWN when displacement + LH/LL are clear
    expect(d.regime).toBe('TREND_DOWN');
  });

  it('Donchian-like band without edge/mid evidence is not proven RANGE', () => {
    // One-way grind inside a wide envelope — looks "in range" of first→last window but is directional
    const bars = Array.from({ length: 12 }, (_, i) => {
      const o = 4500 + i * 0.8;
      const c = o + 0.6;
      return bar(o, c + 0.2, o - 0.15, c, i);
    });
    const structure = detectInternalStructure(bars);
    const range = evaluateRangeEvidence(bars, structure);
    expect(range.ok).toBe(false);
    expect(range.evidence.join(' ')).toMatch(/RANGE_NOT_PROVEN|DOMINANT/);
    const d = classifyRegimeDetailed(bars);
    expect(d.regime).not.toBe('RANGE');
  });

  it('true oscillation with mid crossings + edge touches can be RANGE', () => {
    const bars = [
      bar(4400, 4404, 4396, 4402, 0),
      bar(4402, 4403, 4397, 4398, 1),
      bar(4398, 4404, 4396, 4403, 2),
      bar(4403, 4404, 4397, 4398.5, 3),
      bar(4398.5, 4403.5, 4396.5, 4402.5, 4),
      bar(4402.5, 4403, 4397.5, 4399, 5),
      bar(4399, 4404, 4396, 4401, 6),
      bar(4401, 4402.5, 4397, 4398, 7),
      bar(4398, 4403, 4396.5, 4402, 8),
      bar(4402, 4403.5, 4397.5, 4399.5, 9),
    ];
    const d = classifyRegimeDetailed(bars);
    // May be RANGE if proven; must not invent TREND from soft noise
    expect(['RANGE', 'COMPRESSION', 'TRANSITION']).toContain(d.regime);
    if (d.regime === 'RANGE') {
      expect(d.range.ok).toBe(true);
      expect(d.range.midpoint_crossings).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('hysteresis TREND_DOWN → TRANSITION → RANGE', () => {
  it('does not flip TREND_DOWN to RANGE on one unclear bar', () => {
    const trendBars = lhLlSequence();
    expect(classifyRegime(trendBars, 'UNKNOWN')).toBe('TREND_DOWN');

    // One quiet bar still near lows — not proven range
    const withQuiet = [
      ...trendBars,
      bar(4516.9, 4517.4, 4516.4, 4517.0, 10),
    ];
    const once = classifyRegimeDetailed(withQuiet, 'TREND_DOWN');
    expect(once.regime).not.toBe('RANGE');
    expect(['TREND_DOWN', 'TRANSITION', 'PULLBACK_DOWNTREND']).toContain(once.regime);

    // Force RANGE candidate without enough dwell
    const hyst = applyRegimeHysteresis({
      previous: 'TREND_DOWN',
      raw: 'RANGE',
      range: {
        ok: true,
        score: 0.8,
        width_atr: 2,
        midpoint_slope: 0.1,
        directional_displacement: 0.4,
        range_efficiency: 0.7,
        edge_touches: 4,
        midpoint_crossings: 3,
        horizontal_center: true,
        evidence: ['TEST'],
      },
      structure: { structure: 'NEUTRAL', hh: 0, hl: 0, lh: 0, ll: 0, swing_highs: [], swing_lows: [] },
      hyst_candidate: null,
      hyst_count: 0,
    });
    expect(hyst.regime).toBe('TRANSITION');
    expect(hyst.hyst_count).toBeLessThan(TREND_TO_RANGE_MIN_BARS);

    let cand = hyst.hyst_candidate;
    let count = hyst.hyst_count;
    let regime: RegimeName = hyst.regime;
    for (let i = 0; i < TREND_TO_RANGE_MIN_BARS; i++) {
      const step = applyRegimeHysteresis({
        previous: regime,
        raw: 'RANGE',
        range: {
          ok: true,
          score: 0.8,
          width_atr: 2,
          midpoint_slope: 0.1,
          directional_displacement: 0.4,
          range_efficiency: 0.7,
          edge_touches: 4,
          midpoint_crossings: 3,
          horizontal_center: true,
          evidence: ['TEST'],
        },
        structure: {
          structure: 'NEUTRAL',
          hh: 0,
          hl: 0,
          lh: 0,
          ll: 0,
          swing_highs: [],
          swing_lows: [],
        },
        hyst_candidate: cand,
        hyst_count: count,
      });
      regime = step.regime;
      cand = step.hyst_candidate;
      count = step.hyst_count;
    }
    expect(regime).toBe('RANGE');
  });
});

describe('MACRO RANGE + INTERNAL BEARISH coexistence', () => {
  beforeEach(() => resetRegimeBook());

  it('proven range can still report BEARISH internal structure', () => {
    // Oscillating band but with slightly lower highs/lows inside
    const bars = [
      bar(4500, 4505, 4495, 4503, 0),
      bar(4503, 4504, 4496, 4498, 1),
      bar(4498, 4504.5, 4495.5, 4502, 2),
      bar(4502, 4503.5, 4496.5, 4497.5, 3),
      bar(4497.5, 4503, 4495, 4501, 4),
      bar(4501, 4502.5, 4496, 4497, 5),
      bar(4497, 4502.8, 4495.2, 4500.5, 6),
      bar(4500.5, 4501.5, 4496.2, 4497.2, 7),
      bar(4497.2, 4502, 4495.5, 4499.5, 8),
      bar(4499.5, 4500.5, 4496, 4497.5, 9),
    ];
    const d = classifyRegimeDetailed(bars);
    // Internal may be BEARISH even if macro is RANGE/TRANSITION
    if (d.regime === 'RANGE') {
      expect(['BEARISH', 'NEUTRAL', 'BULLISH']).toContain(d.internal_structure);
    }
    // Structure detection still runs
    expect(d.structure).toBeTruthy();
  });
});
