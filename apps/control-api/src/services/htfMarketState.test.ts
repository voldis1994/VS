import { describe, expect, it } from 'vitest';
import type { TfCandle } from './multiTfRead.js';
import {
  buildHtfMarketState,
  closedCandlesOnly,
  compactHtfMarketState,
  evaluateHtfPathStatus,
  hierarchicalBias,
  htfExpectancyKey,
  structureFromSwings,
  trackHtfPathLive,
  trendFromStructure,
  type HtfTfState,
} from './htfMarketState.js';

function c(o: number, h: number, l: number, close: number): TfCandle {
  return { open: o, high: h, low: l, close };
}

/** Rising HH/HL series + forming tip (last) that must be ignored for structure. */
function bullishSeries(): TfCandle[] {
  return [
    c(100, 101, 99.5, 100.5),
    c(100.5, 102, 100.2, 101.5),
    c(101.5, 103, 101, 102.5),
    c(102.5, 104, 102, 103.5),
    c(103.5, 105, 103, 104.5),
    c(104.5, 106, 104, 105.5),
    c(105.5, 107, 105, 106.5),
    c(106.5, 108, 106, 107.5),
    // forming tip — if used would invent future; must be dropped
    c(107.5, 110, 107, 109.5),
  ];
}

function bearishSeries(): TfCandle[] {
  return [
    c(110, 110.5, 109, 109.5),
    c(109.5, 110, 108, 108.5),
    c(108.5, 109, 107, 107.5),
    c(107.5, 108, 106, 106.5),
    c(106.5, 107, 105, 105.5),
    c(105.5, 106, 104, 104.5),
    c(104.5, 105, 103, 103.5),
    c(103.5, 104, 102, 102.5),
    c(102.5, 103, 100, 100.5),
  ];
}

function rangeSeries(): TfCandle[] {
  return [
    c(100, 101, 99, 100.2),
    c(100.2, 101.1, 99.1, 99.8),
    c(99.8, 100.9, 99, 100.3),
    c(100.3, 101, 99.2, 99.7),
    c(99.7, 100.8, 99.1, 100.1),
    c(100.1, 101.2, 99.3, 99.9),
    c(99.9, 100.7, 99, 100.0),
    c(100.0, 101, 99.2, 100.1),
    c(100.1, 100.5, 99.8, 100.2),
  ];
}

describe('htfMarketState — no lookahead', () => {
  it('closedCandlesOnly drops forming tip', () => {
    const raw = bullishSeries();
    const closed = closedCandlesOnly(raw);
    expect(closed.length).toBe(raw.length - 1);
    expect(closed[closed.length - 1]!.close).toBe(107.5);
  });

  it('structure pivots ignore forming tip (no future peek)', () => {
    const withTip = buildHtfMarketState({
      tf4h: bullishSeries(),
      tf1h: bullishSeries(),
      tf30: bullishSeries(),
      tf15: bullishSeries(),
      tf5: bullishSeries(),
      now_ms: 1,
    });
    const withoutTip = buildHtfMarketState({
      tf4h: bullishSeries().slice(0, -1),
      tf1h: bullishSeries().slice(0, -1),
      tf30: bullishSeries().slice(0, -1),
      tf15: bullishSeries().slice(0, -1),
      tf5: bullishSeries().slice(0, -1),
      now_ms: 1,
    });
    // Same closed window → same bias/structure
    expect(withTip.bias).toBe(withoutTip.bias);
    expect(withTip.primary_thesis.structure).toBe(withoutTip.primary_thesis.structure);
    expect(withTip.frames[0]!.swing_high).toBe(withoutTip.frames[0]!.swing_high);
  });
});

describe('htfMarketState — hierarchy not majority vote', () => {
  it('4H DOWN leads even if lower TFs are mixed UP (no majority flip)', () => {
    const state = buildHtfMarketState({
      tf4h: bearishSeries(),
      tf1h: bearishSeries(),
      // lower TFs bounce — pullback inside bearish HTF, must NOT invent BUY bias
      tf30: bullishSeries().slice(0, 5),
      tf15: bullishSeries().slice(0, 5),
      tf5: bullishSeries().slice(0, 5),
      now_ms: 1,
    });
    expect(state.bias).toBe('DOWN');
    expect(state.primary_thesis.side).toBe('SELL');
    expect(state.primary_thesis.anchor_tf).toBe('4H');
    // Lower bounce should refine phase toward pullback/transition, not flip bias
    expect(['PULLBACK', 'TRANSITION', 'IMPULSE', 'EXPANSION']).toContain(
      state.primary_thesis.phase
    );
  });

  it('hierarchicalBias does not count votes', () => {
    const frames: HtfTfState[] = [
      {
        tf: '4H',
        structure: 'LL',
        trend: 'DOWN',
        maturity: 'MID',
        phase: 'IMPULSE',
        swing_high: 110,
        swing_low: 100,
        last_swing_high: null,
        last_swing_low: null,
        liquidity: 'NONE',
        price_location: 'DISCOUNT',
        breakout: 'NONE',
        volatility: 'NORMAL',
        dir: 'DOWN',
        confidence: 0.8,
        structure_pos: 0.2,
      },
      {
        tf: '1H',
        structure: 'HH',
        trend: 'UP',
        maturity: 'EARLY',
        phase: 'PULLBACK',
        swing_high: 105,
        swing_low: 101,
        last_swing_high: null,
        last_swing_low: null,
        liquidity: 'NONE',
        price_location: 'PREMIUM',
        breakout: 'NONE',
        volatility: 'NORMAL',
        dir: 'UP',
        confidence: 0.6,
        structure_pos: 0.7,
      },
      {
        tf: '30m',
        structure: 'HH',
        trend: 'UP',
        maturity: 'EARLY',
        phase: 'IMPULSE',
        swing_high: 104,
        swing_low: 102,
        last_swing_high: null,
        last_swing_low: null,
        liquidity: 'NONE',
        price_location: 'MID_RANGE',
        breakout: 'NONE',
        volatility: 'NORMAL',
        dir: 'UP',
        confidence: 0.55,
        structure_pos: 0.5,
      },
      {
        tf: '15m',
        structure: 'HH',
        trend: 'UP',
        maturity: 'EARLY',
        phase: 'IMPULSE',
        swing_high: 104,
        swing_low: 102,
        last_swing_high: null,
        last_swing_low: null,
        liquidity: 'NONE',
        price_location: 'MID_RANGE',
        breakout: 'NONE',
        volatility: 'NORMAL',
        dir: 'UP',
        confidence: 0.55,
        structure_pos: 0.5,
      },
      {
        tf: '5m',
        structure: 'HH',
        trend: 'UP',
        maturity: 'EARLY',
        phase: 'IMPULSE',
        swing_high: 104,
        swing_low: 102,
        last_swing_high: null,
        last_swing_low: null,
        liquidity: 'NONE',
        price_location: 'MID_RANGE',
        breakout: 'NONE',
        volatility: 'NORMAL',
        dir: 'UP',
        confidence: 0.55,
        structure_pos: 0.5,
      },
    ];
    // 4 of 5 frames UP — majority would be UP; hierarchy keeps 4H DOWN as pullback
    const upCount = frames.filter((f) => f.trend === 'UP').length;
    expect(upCount).toBeGreaterThan(frames.filter((f) => f.trend === 'DOWN').length);
    const h = hierarchicalBias(frames);
    expect(h.bias).toBe('DOWN');
    expect(h.phase).toBe('PULLBACK');
  });
});

describe('htfMarketState — structure & path', () => {
  it('bullish book → BUY thesis + expected path + compact', () => {
    const state = buildHtfMarketState({
      tf4h: bullishSeries(),
      tf1h: bullishSeries(),
      tf30: bullishSeries(),
      tf15: bullishSeries(),
      tf5: bullishSeries(),
      live_price: 107,
      now_ms: 42,
    });
    expect(state.bias).toBe('UP');
    expect(state.primary_thesis.side).toBe('BUY');
    expect(state.alternative_thesis.side).toBe('SELL');
    expect(state.expected_path.description.length).toBeGreaterThan(10);
    expect(state.invalidation.length).toBeGreaterThan(5);
    expect(state.confidence).toBeGreaterThan(0.3);
    expect(state.frames.map((f) => f.tf)).toEqual(['4H', '1H', '30m', '15m', '5m']);
    const compact = compactHtfMarketState(state)!;
    expect(compact.primary_side).toBe('BUY');
    expect(compact.bias).toBe('UP');
    expect(compact.expected_path).toBe(state.expected_path.description);
  });

  it('range book stays low-confidence / non-impulse (no fake HTF chase)', () => {
    const state = buildHtfMarketState({
      tf30: rangeSeries(),
      tf15: rangeSeries(),
      tf5: rangeSeries(),
      now_ms: 1,
    });
    // Chop/range: either WAIT, FLAT bias, RANGE structure, or compression/transition
    const choppy =
      state.primary_thesis.side === 'WAIT' ||
      state.bias === 'FLAT' ||
      state.primary_thesis.structure === 'RANGE' ||
      state.primary_thesis.structure === 'UNKNOWN' ||
      state.primary_thesis.phase === 'COMPRESSION' ||
      state.primary_thesis.phase === 'TRANSITION' ||
      state.confidence < 0.7;
    expect(choppy).toBe(true);
  });

  it('structureFromSwings HH/HL vs LL/LH', () => {
    expect(
      structureFromSwings(
        [
          { index: 1, price: 100, kind: 'H' },
          { index: 3, price: 105, kind: 'H' },
        ],
        [
          { index: 2, price: 98, kind: 'L' },
          { index: 4, price: 101, kind: 'L' },
        ]
      )
    ).toBe('HH');
    expect(
      structureFromSwings(
        [
          { index: 1, price: 110, kind: 'H' },
          { index: 3, price: 105, kind: 'H' },
        ],
        [
          { index: 2, price: 100, kind: 'L' },
          { index: 4, price: 97, kind: 'L' },
        ]
      )
    ).toBe('LL');
  });

  it('trendFromStructure respects failed bullish path', () => {
    expect(trendFromStructure('HH', 5, 100)).toBe('UP');
    expect(trendFromStructure('HH', -5, 100)).toBe('FLAT');
  });

  it('path confirm / invalidate without lookahead', () => {
    const path = {
      description: 'test',
      next_events: ['hold_hl'],
      confirm_levels: [105],
      invalidate_levels: [100],
    };
    expect(
      evaluateHtfPathStatus({
        live_price: 99,
        bias: 'UP',
        expected_path: path,
      })
    ).toBe('INVALIDATED');
    expect(
      evaluateHtfPathStatus({
        live_price: 106,
        bias: 'UP',
        expected_path: path,
      })
    ).toBe('CONFIRMING');
    expect(
      evaluateHtfPathStatus({
        live_price: 106,
        bias: 'UP',
        expected_path: path,
        prior_status: 'CONFIRMING',
      })
    ).toBe('CONFIRMED');
  });

  it('trackHtfPathLive invalidates on live hierarchical flip', () => {
    const entry = buildHtfMarketState({
      tf4h: bullishSeries(),
      tf1h: bullishSeries(),
      tf30: bullishSeries(),
      now_ms: 1,
    });
    const live = buildHtfMarketState({
      tf4h: bearishSeries(),
      tf1h: bearishSeries(),
      tf30: bearishSeries(),
      now_ms: 2,
    });
    expect(entry.bias).toBe('UP');
    expect(live.bias).toBe('DOWN');
    const status = trackHtfPathLive({
      entry_htf: entry,
      live_price: 100,
      live_htf: live,
    });
    expect(status).toBe('INVALIDATED');
  });

  it('htfExpectancyKey stable', () => {
    expect(
      htfExpectancyKey({
        structure: 'hh',
        phase: 'pullback',
        setup: 'pullback',
        side: 'buy',
      })
    ).toBe('HH|PULLBACK|PULLBACK|BUY');
  });
});
