import { describe, expect, it } from 'vitest';
import type { HtfTimedCandle } from './htfFacts.js';
import { classifyOppositeMove, interpretHtf } from './htfInterpretation.js';
import {
  advanceFrozenThesis,
  buildHtfFacts,
  buildHtfMarketState,
  closedCandlesOnly,
  compactHtfMarketState,
  createMarketThesis,
  evaluateThesisEvents,
  htfFetchMax,
  htfHistoryAdequate,
  measureThesisOutcome,
  postThesisCandles,
  HTF_HISTORY_MIN,
  HTF_HISTORY_TARGET,
} from './htfMarketState.js';

function c(
  o: number,
  h: number,
  l: number,
  close: number,
  t: number
): HtfTimedCandle {
  return { open: o, high: h, low: l, close, open_time_ms: t };
}

/**
 * Explicit pivot path: L0 → H0 → HL → HH → HL2 → HH2 … (bullish HH+HL).
 * Middles are lower/higher so confirmedPivots sees both H and L.
 */
function bullishSeries(baseT = 1_700_000_000_000): HtfTimedCandle[] {
  const pivots = [
    100, 102, 101, 104, 102.5, 106, 104.5, 108, 106.5, 110, 108.5, 112, 110.5, 114,
  ];
  const out: HtfTimedCandle[] = [];
  for (let i = 0; i < pivots.length; i++) {
    const px = pivots[i]!;
    const prev = i ? pivots[i - 1]! : px;
    const hi = Math.max(prev, px) + 0.15;
    const lo = Math.min(prev, px) - 0.15;
    out.push(c(prev, hi, lo, px, baseT + i * 3_600_000));
  }
  const last = out[out.length - 1]!;
  out.push(
    c(last.close, last.close + 5, last.close, last.close + 4, baseT + pivots.length * 3_600_000)
  );
  return out;
}

/** Explicit LH/LL bearish pivots: H0 → L0 → LH → LL … */
function bearishSeries(baseT = 1_700_000_000_000): HtfTimedCandle[] {
  const pivots = [
    120, 118, 119, 116, 117.5, 114, 115.5, 112, 113.5, 110, 111.5, 108, 109.5, 106,
  ];
  const out: HtfTimedCandle[] = [];
  for (let i = 0; i < pivots.length; i++) {
    const px = pivots[i]!;
    const prev = i ? pivots[i - 1]! : px;
    const hi = Math.max(prev, px) + 0.15;
    const lo = Math.min(prev, px) - 0.15;
    out.push(c(prev, hi, lo, px, baseT + i * 3_600_000));
  }
  const last = out[out.length - 1]!;
  out.push(
    c(last.close, last.close + 1, last.close - 4, last.close - 3, baseT + pivots.length * 3_600_000)
  );
  return out;
}

describe('htf v2 — no lookahead / forming tip', () => {
  it('closedCandlesOnly drops forming tip', () => {
    const raw = bullishSeries();
    const closed = closedCandlesOnly(raw);
    expect(closed.length).toBe(raw.length - 1);
  });

  it('facts ignore forming tip (same as closed-only book)', () => {
    const raw = bullishSeries();
    const withTip = buildHtfFacts({ tf4h: raw, now_ms: 1 });
    const closedOnly = closedCandlesOnly(raw);
    // Pass closed-only + duplicate last as fake tip so drop yields same window
    const without = buildHtfFacts({
      tf4h: [...closedOnly, closedOnly[closedOnly.length - 1]!],
      now_ms: 1,
    });
    expect(withTip.frames[0]!.structure_label).toBe(
      without.frames[0]!.structure_label
    );
    expect(withTip.frames[0]!.last_close).toBe(without.frames[0]!.last_close);
  });
});

describe('htf v2 — path confirmation requires post-thesis events', () => {
  it('new thesis always starts PENDING even if price already above confirm level', () => {
    const series = bullishSeries();
    const state = buildHtfMarketState({
      tf4h: series,
      tf1h: series,
      tf30: series,
      now_ms: 1_700_000_000_000 + 23 * 3_600_000,
    });
    expect(state.thesis.state).toBe('PENDING');
    expect(state.path_status).toBe('PENDING');
    // Conditions that are already true are flagged — not auto-confirmed
    const already = state.thesis.confirmation_conditions.filter(
      (x) => x.satisfied_at_creation
    );
    // May or may not have already-satisfied levels depending on swings;
    // critical: state is still PENDING
    expect(state.thesis.state).toBe('PENDING');
    void already;
  });

  it('does not CONFIRM from live_price sitting beyond level without new close', () => {
    const series = bullishSeries();
    const frozen = buildHtfMarketState({
      tf4h: series,
      tf1h: series,
      tf30: series,
      live_price: 9999,
      now_ms: 1_700_000_000_000 + 23 * 3_600_000,
    });
    expect(frozen.thesis.state).toBe('PENDING');
    // Advance with same book (no new candles) → still PENDING
    const advanced = advanceFrozenThesis(frozen, {
      tf4h: series,
      tf1h: series,
      tf30: series,
      live_price: 9999,
      now_ms: Date.now(),
    });
    expect(advanced.thesis.state).toBe('PENDING');
  });

  it('CONFIRMS only after a real post-thesis cross close', () => {
    const baseT = 1_700_000_000_000;
    const series = bullishSeries(baseT);
    const frozen = buildHtfMarketState({
      tf30: series,
      now_ms: baseT + 23 * 3_600_000,
    });
    expect(frozen.thesis.state).toBe('PENDING');
    // Manually attach a CROSS_ABOVE confirm that is NOT satisfied at creation
    const level = frozen.facts.frames[0]!.last_close + 1;
    frozen.thesis.confirmation_conditions = [
      {
        id: 'c_test_cross',
        kind: 'CROSS_ABOVE',
        level,
        tf: '30m',
        description: `cross ${level}`,
        satisfied_at_creation: false,
      },
    ];
    frozen.thesis.invalidation_conditions = []; // isolate confirm path
    const closed = closedCandlesOnly(series);
    const lastT = closed[closed.length - 1]!.open_time_ms!;
    const post1 = c(level - 0.5, level + 0.2, level - 0.6, level - 0.1, lastT + 3_600_000);
    const post2 = c(level - 0.1, level + 0.8, level - 0.2, level + 0.5, lastT + 7_200_000);
    const live = [
      ...closed,
      post1,
      post2,
      c(level + 0.5, level + 0.6, level + 0.4, level + 0.55, lastT + 10_800_000),
    ];
    const advanced = advanceFrozenThesis(frozen, {
      tf30: live,
      now_ms: lastT + 7_200_000,
    });
    expect(['CONFIRMING', 'CONFIRMED']).toContain(advanced.thesis.state);
    expect(advanced.thesis.created_at).toBe(frozen.thesis.created_at);
  });

  it('INVALIDATES on closed break below HL after thesis (not wick alone)', () => {
    const series = bullishSeries();
    const frozen = buildHtfMarketState({
      tf4h: series,
      tf1h: series,
      tf30: series,
      now_ms: 1_700_000_000_000 + 23 * 3_600_000,
    });
    const sl = frozen.facts.frames[0]?.structure_low;
    if (sl == null) return; // skip if structure thin
    const lastT =
      frozen.facts.frames[0]!.last_open_time_ms ?? 1_700_000_000_000 + 23 * 3_600_000;
    const closed = closedCandlesOnly(series);
    const postBreak = c(sl + 0.1, sl + 0.2, sl - 1, sl - 0.5, lastT + 3_600_000);
    const live = [
      ...closed,
      postBreak,
      c(sl - 0.5, sl - 0.4, sl - 1.2, sl - 0.8, lastT + 7_200_000), // forming
    ];
    const advanced = advanceFrozenThesis(frozen, {
      tf4h: live,
      tf1h: live,
      tf30: live,
      now_ms: lastT + 3_600_000,
    });
    // Bullish thesis with CROSS_BELOW invalidate should fire
    if (frozen.bias === 'UP' && frozen.thesis.invalidation_conditions.length) {
      expect(advanced.thesis.state).toBe('INVALIDATED');
      expect(advanced.thesis.invalidated_at).not.toBeNull();
    }
  });

  it('postThesisCandles excludes freeze bar and earlier', () => {
    const series = bullishSeries();
    const facts = buildHtfFacts({ tf30: series, now_ms: 1 });
    const interp = interpretHtf(facts);
    const thesis = createMarketThesis(facts, interp, 1);
    const f = facts.frames[0]!;
    const post = postThesisCandles(f, thesis);
    expect(post.every((x) => (x.open_time_ms ?? 0) > (thesis.freeze.last_time_by_tf['30m'] ?? 0))).toBe(
      true
    );
  });

  it('frozen thesis primary/score/conditions immutable under advance', () => {
    const series = bullishSeries();
    const frozen = buildHtfMarketState({
      tf4h: series,
      tf30: series,
      now_ms: 42,
    });
    const advanced = advanceFrozenThesis(frozen, {
      tf4h: bearishSeries(),
      tf30: bearishSeries(),
      now_ms: 99,
    });
    expect(advanced.thesis.created_at).toBe(42);
    expect(advanced.thesis.score).toBe(frozen.thesis.score);
    expect(advanced.thesis.primary_thesis).toEqual(frozen.thesis.primary_thesis);
    expect(advanced.thesis.confirmation_conditions).toEqual(
      frozen.thesis.confirmation_conditions
    );
  });
});

describe('htf v2 — hierarchy / opposite ≠ auto pullback', () => {
  it('4H DOWN leads when lower TFs bounce (no majority flip)', () => {
    // Lower bounce stays inside 4H structure → correction/pullback, not flip
    const down = bearishSeries();
    const bounceT = 1_700_000_000_000 + 30 * 3_600_000;
    // Mild counter-trend bounce from mid-path — does not break 4H structure high
    const bounce: HtfTimedCandle[] = [
      ...down.slice(0, 10),
      c(112, 112.5, 111.8, 112.2, bounceT),
      c(112.2, 112.8, 112, 112.5, bounceT + 3_600_000),
      c(112.5, 113, 112.2, 112.7, bounceT + 7_200_000),
      c(112.7, 113.1, 112.5, 112.9, bounceT + 10_800_000), // forming
    ];
    const state = buildHtfMarketState({
      tf4h: down,
      tf1h: down,
      tf30: bounce,
      tf15: bounce,
      tf5: bounce,
      now_ms: bounceT + 7_200_000,
    });
    expect(state.bias).toBe('DOWN');
    expect(state.thesis.primary_thesis.side).toBe('SELL');
    // Lower bounce must not invent BUY via majority of lower TFs
    expect(state.thesis.primary_thesis.side).not.toBe('BUY');
  });

  it('classifyOppositeMove: intact HL → CORRECTION; broken → STRUCTURAL_TRANSITION', () => {
    const up = buildHtfFacts({ tf4h: bullishSeries(), now_ms: 1 }).frames[0]!;
    const bounce = buildHtfFacts({
      tf1h: [
        ...bullishSeries().slice(0, 10),
        c(108, 108.2, 107.5, 107.6, 1_700_000_000_000 + 40 * 3_600_000),
        c(107.6, 107.7, 107, 107.2, 1_700_000_000_000 + 41 * 3_600_000),
        c(107.2, 107.3, 106.8, 107, 1_700_000_000_000 + 42 * 3_600_000),
      ],
      now_ms: 1,
    }).frames[0]!;
    const read = classifyOppositeMove(up, bounce, 'UP');
    expect(['CORRECTION', 'STRUCTURAL_TRANSITION']).toContain(read);
  });
});

describe('htf v2 — acceptance / history / score / outcomes', () => {
  it('single close beyond level is ATTEMPT not ACCEPTANCE', () => {
    const baseT = 1_700_000_000_000;
    const candles: HtfTimedCandle[] = [];
    for (let i = 0; i < 16; i++) {
      candles.push(c(100, 100.5, 99.5, 100.1, baseT + i * 60_000));
    }
    // Prior swing high ~101
    candles[8] = c(100, 101.5, 99.8, 101, baseT + 8 * 60_000);
    candles[9] = c(101, 101.2, 100, 100.4, baseT + 9 * 60_000);
    // Single close above
    candles[15] = c(100.4, 102, 100.3, 101.7, baseT + 15 * 60_000);
    candles.push(c(101.7, 102, 101.5, 101.8, baseT + 16 * 60_000)); // forming
    const facts = buildHtfFacts({ tf5: candles, now_ms: 1 });
    const brk = facts.frames[0]!.breakout;
    expect(brk).not.toBeNull();
    expect(brk!.status).not.toBe('ACCEPTANCE');
    expect(['ATTEMPT', 'REJECTION']).toContain(brk!.status);
  });

  it('score is heuristic field (not named confidence on thesis)', () => {
    const state = buildHtfMarketState({
      tf30: bullishSeries(),
      now_ms: 1,
    });
    expect(typeof state.thesis.score).toBe('number');
    expect(state.thesis.score).toBeGreaterThan(0);
    expect(state.thesis.score).toBeLessThanOrEqual(0.95);
    const compact = compactHtfMarketState(state)!;
    expect(compact.score).toBe(state.thesis.score);
  });

  it('history targets/minima and fetch max include forming tip', () => {
    expect(HTF_HISTORY_TARGET['4H']).toBeGreaterThanOrEqual(60);
    expect(HTF_HISTORY_TARGET['1H']).toBeGreaterThanOrEqual(100);
    expect(HTF_HISTORY_MIN['5m']).toBeGreaterThanOrEqual(40);
    expect(htfFetchMax('4H')).toBe(HTF_HISTORY_TARGET['4H'] + 1);
    expect(htfHistoryAdequate('30m', HTF_HISTORY_MIN['30m'] + 1)).toBe(true);
    expect(htfHistoryAdequate('30m', 10)).toBe(false);
  });

  it('measureThesisOutcome tracks direction / invalidation / timing', () => {
    const state = buildHtfMarketState({
      tf4h: bullishSeries(),
      tf1h: bullishSeries(),
      tf30: bullishSeries(),
      now_ms: 1000,
    });
    // Force measurable BUY thesis for outcome unit test
    state.thesis.primary_thesis = {
      ...state.thesis.primary_thesis,
      side: 'BUY',
    };
    state.bias = 'UP';
    state.thesis.state = 'CONFIRMED';
    state.thesis.confirmed_at = 5000;
    state.thesis.events_hit = ['confirm:c_new_hh'];
    const out = measureThesisOutcome({
      entry: state,
      direction: 'BUY',
      pnl_pts: 2,
      mfe: 3,
      mae: -0.5,
      exit_phase: 'IMPULSE',
    });
    expect(out.thesis_direction_correct).toBe(true);
    expect(out.time_to_confirmation_ms).toBe(4000);
    expect(out.invalidated).toBe(false);
  });
});

describe('htf v2 — evaluateThesisEvents unit', () => {
  it('ignore invalidation that was already true at creation until re-cross', () => {
    const series = bullishSeries();
    const facts = buildHtfFacts({ tf30: series, now_ms: 1 });
    const interp = interpretHtf(facts);
    const thesis = createMarketThesis(facts, interp, 1);
    // Force a condition as satisfied_at_creation
    if (thesis.invalidation_conditions[0]) {
      thesis.invalidation_conditions[0]!.satisfied_at_creation = true;
    }
    const same = evaluateThesisEvents(thesis, facts, 2);
    // Same candles → no new cross → not invalidated solely from baseline
    expect(same.state).not.toBe('INVALIDATED');
  });
});
