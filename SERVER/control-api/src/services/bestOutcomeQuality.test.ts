import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_ALPHA,
  candleConfirm,
  computeBestOutcomeScore,
  computeNextSignalConfirm,
  computeNextSignalDirection,
  computeRetention,
  evaluateBestOutcomeQuality,
  feedConfirm,
  hasMeaningfulProfit,
  inferMarketDirectionFromFeed,
  momentumConfirm,
  regimeConfirm,
} from './bestOutcomeQuality.js';
import {
  buildExitSnapshotFromClose,
  evaluatePendingWithNextSignal,
  getLastBestOutcomeEvaluation,
  getPendingBestOutcomeSnapshot,
  resetBestOutcomePendingStore,
  saveBestOutcomeExitSnapshot,
} from './bestOutcomePendingStore.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import type { MultiFeedPrice } from './robotReader.js';

function bar(open: number, close: number): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + 0.3,
    low: Math.min(open, close) - 0.3,
    close,
    ticks: 12,
  };
}

function strongSellBars(): TenSecBar[] {
  return [bar(3300, 3298), bar(3298, 3295), bar(3295, 3292), bar(3292, 3290)];
}

function strongBuyBars(): TenSecBar[] {
  return [bar(3300, 3302), bar(3302, 3305), bar(3305, 3308), bar(3308, 3310)];
}

function feedStrong(): MultiFeedPrice {
  return {
    epic: 'GOLD',
    mid: 3300,
    contributing: 4,
    sender_count: 5,
    agreement: 'STRONG',
    mids: [3300, 3300.1],
    legs: [],
    detail: 'test',
  };
}

describe('Best Outcome quality — retention', () => {
  it('computes R = UPL / MFE', () => {
    expect(computeRetention(10, 8)).toBeCloseTo(0.8, 6);
  });

  it('returns null for MFE = 0', () => {
    expect(computeRetention(0, 8)).toBeNull();
  });

  it('returns null for negative MFE', () => {
    expect(computeRetention(-5, 3)).toBeNull();
  });

  it('handles negative UPL', () => {
    expect(computeRetention(10, -2)).toBeCloseTo(-0.2, 6);
  });

  it('returns null for NaN / missing', () => {
    expect(computeRetention(NaN, 8)).toBeNull();
    expect(computeRetention(10, null)).toBeNull();
    expect(computeRetention(undefined, 8)).toBeNull();
  });
});

describe('Best Outcome quality — next signal direction', () => {
  it('SELL → BUY gives D = +1', () => {
    expect(computeNextSignalDirection('SELL', 'BUY')).toBe(1);
  });

  it('SELL → SELL gives D = −1', () => {
    expect(computeNextSignalDirection('SELL', 'SELL')).toBe(-1);
  });

  it('BUY → SELL gives D = +1', () => {
    expect(computeNextSignalDirection('BUY', 'SELL')).toBe(1);
  });

  it('BUY → BUY gives D = −1', () => {
    expect(computeNextSignalDirection('BUY', 'BUY')).toBe(-1);
  });

  it('no next signal gives D = 0', () => {
    expect(computeNextSignalDirection('SELL', null)).toBe(0);
  });
});

describe('Best Outcome quality — formula scenarios', () => {
  const mfe = 10;
  const upl = 8;
  const r = 0.8;
  const alpha = BEST_OUTCOME_ALPHA;

  it('1. SELL → good MFE/UPL → BUY strong confirm', () => {
    const c = 0.9;
    const bo = computeBestOutcomeScore({
      mfe,
      uplAtExit: upl,
      previousSide: 'SELL',
      nextSide: 'BUY',
      nextConfirm: c,
    });
    expect(bo.retention).toBeCloseTo(r, 6);
    expect(bo.next_signal_direction).toBe(1);
    expect(bo.best_outcome_score).toBeCloseTo(r + alpha * 1 * c, 6);
    expect(bo.best_outcome_score).toBeCloseTo(1.025, 6);
  });

  it('2. SELL → good MFE/UPL → SELL strong confirm', () => {
    const c = 0.9;
    const bo = computeBestOutcomeScore({
      mfe,
      uplAtExit: upl,
      previousSide: 'SELL',
      nextSide: 'SELL',
      nextConfirm: c,
    });
    expect(bo.best_outcome_score).toBeCloseTo(r + alpha * -1 * c, 6);
    expect(bo.best_outcome_score).toBeCloseTo(0.575, 6);
  });

  it('3. SELL → good MFE/UPL → SELL weak confirm', () => {
    const c = 0.15;
    const bo = computeBestOutcomeScore({
      mfe,
      uplAtExit: upl,
      previousSide: 'SELL',
      nextSide: 'SELL',
      nextConfirm: c,
    });
    expect(bo.best_outcome_score).toBeCloseTo(0.7625, 6);
  });

  it('4. BUY → good MFE/UPL → SELL strong confirm', () => {
    const c = 0.9;
    const bo = computeBestOutcomeScore({
      mfe,
      uplAtExit: upl,
      previousSide: 'BUY',
      nextSide: 'SELL',
      nextConfirm: c,
    });
    expect(bo.next_signal_direction).toBe(1);
    expect(bo.best_outcome_score).toBeCloseTo(1.025, 6);
  });

  it('5. BUY → good MFE/UPL → BUY strong confirm', () => {
    const c = 0.9;
    const bo = computeBestOutcomeScore({
      mfe,
      uplAtExit: upl,
      previousSide: 'BUY',
      nextSide: 'BUY',
      nextConfirm: c,
    });
    expect(bo.next_signal_direction).toBe(-1);
    expect(bo.best_outcome_score).toBeCloseTo(0.575, 6);
  });

  it('6. no Next Signal — score equals retention only', () => {
    const bo = computeBestOutcomeScore({
      mfe,
      uplAtExit: upl,
      previousSide: 'SELL',
      nextSide: null,
      nextConfirm: null,
    });
    expect(bo.next_signal_direction).toBe(0);
    expect(bo.best_outcome_score).toBeCloseTo(r, 6);
  });

  it('7. MFE = 0 — no score', () => {
    const bo = computeBestOutcomeScore({
      mfe: 0,
      uplAtExit: upl,
      previousSide: 'SELL',
      nextSide: 'BUY',
      nextConfirm: 0.9,
    });
    expect(bo.retention).toBeNull();
    expect(bo.best_outcome_score).toBeNull();
  });

  it('8. negative UPL — retention negative, score finite', () => {
    const bo = computeBestOutcomeScore({
      mfe: 10,
      uplAtExit: -3,
      previousSide: 'SELL',
      nextSide: 'BUY',
      nextConfirm: 0.9,
    });
    expect(bo.retention).toBeCloseTo(-0.3, 6);
    expect(Number.isFinite(bo.best_outcome_score!)).toBe(true);
  });

  it('15. BO formula never NaN/Infinity', () => {
    const cases = [
      { mfe: 0, upl: 0 },
      { mfe: 10, upl: 8 },
      { mfe: NaN, upl: 8 },
      { mfe: 10, upl: Infinity },
    ];
    for (const c of cases) {
      const bo = computeBestOutcomeScore({
        mfe: c.mfe,
        uplAtExit: c.upl,
        previousSide: 'SELL',
        nextSide: 'BUY',
        nextConfirm: 0.9,
      });
      if (bo.best_outcome_score != null) {
        expect(Number.isFinite(bo.best_outcome_score)).toBe(true);
      }
    }
  });
});

describe('Best Outcome quality — confirmation components', () => {
  it('9. missing Feed — renormalizes weights', () => {
    const { confirm, components } = computeNextSignalConfirm({
      side: 'SELL',
      closedBars: strongSellBars(),
      feed: null,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(components.feed).toBeNull();
    expect(components.candle).not.toBeNull();
    expect(confirm).not.toBeNull();
    expect(confirm!).toBeGreaterThanOrEqual(0);
    expect(confirm!).toBeLessThanOrEqual(1);
  });

  it('10. missing Booker — book not in components (never computed)', () => {
    const { components } = computeNextSignalConfirm({
      side: 'BUY',
      closedBars: strongBuyBars(),
      feed: feedStrong(),
      regime: 'TREND_UP',
    });
    expect(components).not.toHaveProperty('book');
    expect(Object.keys(components).sort()).toEqual(['candle', 'feed', 'momentum', 'regime']);
  });

  it('11. missing Regime — uses bias fallback or omits', () => {
    const withBias = regimeConfirm('BUY', null, 'UP');
    expect(withBias).toBe(0.75);
    const { components } = computeNextSignalConfirm({
      side: 'BUY',
      closedBars: strongBuyBars(),
      feed: feedStrong(),
      regime: null,
      bias: null,
    });
    expect(components.regime).toBe(0.5);
  });

  it('12. partial confirmation inputs — normalized', () => {
    const { confirm } = computeNextSignalConfirm({
      side: 'SELL',
      closedBars: null,
      feed: feedStrong(),
      regime: null,
      bias: null,
    });
    expect(confirm).not.toBeNull();
    expect(confirm!).toBeGreaterThanOrEqual(0);
    expect(confirm!).toBeLessThanOrEqual(1);
  });

  it('candle confirm symmetric BUY/SELL', () => {
    const buyC = candleConfirm('BUY', strongBuyBars());
    const sellC = candleConfirm('SELL', strongSellBars());
    expect(buyC!).toBeGreaterThan(0.5);
    expect(sellC!).toBeGreaterThan(0.5);
  });

  it('momentum confirm distinguishes weak vs strong', () => {
    const strong = momentumConfirm('SELL', strongSellBars());
    const neutralBars = [bar(3300, 3300.1), bar(3300.1, 3299.9), bar(3299.9, 3300.05)];
    const weak = momentumConfirm('SELL', neutralBars);
    expect(strong!).toBeGreaterThan(weak!);
  });

  it('feed confirm uses agreement', () => {
    const strong = feedConfirm('BUY', feedStrong());
    const weak = feedConfirm('BUY', { ...feedStrong(), agreement: 'DIVERGENT', contributing: 1 });
    expect(strong!).toBeGreaterThan(weak!);
  });

  it('feed weight boosted when candle/momentum/regime sparse', () => {
    const feedOnly = computeNextSignalConfirm({
      side: 'BUY',
      closedBars: null,
      feed: feedStrong(),
      regime: null,
      bias: null,
    });
    // regime still returns 0.5 for UNKNOWN — so feed + regime; boost when nonFeed <= 1
    expect(feedOnly.components.feed).not.toBeNull();
    expect(feedOnly.confirm).not.toBeNull();
    expect(feedOnly.confirm!).toBeGreaterThan(0.5);
  });
});

describe('Best Outcome quality — feed/bars direction fallback', () => {
  it('infers SELL from TREND_DOWN when Strategy signal missing', () => {
    expect(
      inferMarketDirectionFromFeed({ regime: 'TREND_DOWN', bias: 'FLAT', feed: feedStrong() })
    ).toBe('SELL');
  });

  it('infers BUY from bullish bars when regime/bias flat', () => {
    expect(
      inferMarketDirectionFromFeed({
        regime: 'RANGE',
        bias: 'FLAT',
        closedBars: strongBuyBars(),
        feed: null,
      })
    ).toBe('BUY');
  });

  it('hasMeaningfulProfit rejects micro plus on Gold-scale entry', () => {
    expect(hasMeaningfulProfit(2490, 0.05)).toBe(false);
    expect(hasMeaningfulProfit(2490, 0.5)).toBe(true);
    expect(hasMeaningfulProfit(2490, 3)).toBe(true);
  });
});

describe('Best Outcome quality — BUY/SELL symmetry', () => {
  it('14. symmetric retention for BUY and SELL', () => {
    const sellR = computeRetention(10, 8);
    const buyR = computeRetention(10, 8);
    expect(sellR).toBe(buyR);
  });

  it('symmetric direction flip', () => {
    expect(computeNextSignalDirection('SELL', 'BUY')).toBe(
      computeNextSignalDirection('BUY', 'SELL')
    );
    expect(computeNextSignalDirection('SELL', 'SELL')).toBe(
      computeNextSignalDirection('BUY', 'BUY')
    );
  });

  it('full evaluation symmetric scores for mirrored setups', () => {
    const sellExit = evaluateBestOutcomeQuality({
      mfe: 10,
      uplAtExit: 8,
      previousSide: 'SELL',
      nextSide: 'BUY',
      closedBars: strongBuyBars(),
      feed: feedStrong(),
      regime: 'TREND_UP',
      bias: 'UP',
    });
    const buyExit = evaluateBestOutcomeQuality({
      mfe: 10,
      uplAtExit: 8,
      previousSide: 'BUY',
      nextSide: 'SELL',
      closedBars: strongSellBars(),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(sellExit.next_signal_direction).toBe(1);
    expect(buyExit.next_signal_direction).toBe(1);
    expect(sellExit.retention).toBe(buyExit.retention);
  });
});

describe('Best Outcome pending store', () => {
  it('saves exit snapshot and evaluates on next valid signal', () => {
    resetBestOutcomePendingStore();
    const snap = buildExitSnapshotFromClose({
      robot_id: 'r1_GOLD',
      account_id: 1,
      epic: 'GOLD',
      open_side: 'SELL',
      entry_price: 3300,
      exit_price: 3292,
      mfe: 10,
      upl_at_exit: 8,
      best_outcome_reason: 'BestOutcome EXIT · profit lock',
      best_outcome_state: 'EXIT',
      entry_setup: 'CONTINUATION',
      entry_regime: 'TREND_DOWN',
    });
    saveBestOutcomeExitSnapshot(snap);

    const pending = getPendingBestOutcomeSnapshot(1, 'GOLD');
    expect(pending).not.toBeNull();
    expect(pending!.evaluated).toBe(false);
    expect(pending!.retention).toBeCloseTo(0.8, 6);

    const evalResult = evaluatePendingWithNextSignal({
      account_id: 1,
      epic: 'GOLD',
      next_side: 'BUY',
      closedBars: strongBuyBars(),
      feed: feedStrong(),
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(evalResult).not.toBeNull();
    expect(evalResult!.next_signal_direction).toBe(1);
    expect(evalResult!.best_outcome_score).toBeGreaterThan(0.8);

    const after = getPendingBestOutcomeSnapshot(1, 'GOLD');
    expect(after!.evaluated).toBe(true);
    expect(getLastBestOutcomeEvaluation(1, 'GOLD')).not.toBeNull();
  });

  it('13. does not re-evaluate with second signal', () => {
    resetBestOutcomePendingStore();
    saveBestOutcomeExitSnapshot(
      buildExitSnapshotFromClose({
        robot_id: 'r1_GOLD',
        account_id: 2,
        epic: 'GOLD',
        open_side: 'SELL',
        entry_price: 3300,
        exit_price: 3292,
        mfe: 10,
        upl_at_exit: 8,
        best_outcome_reason: 'exit',
        best_outcome_state: 'EXIT',
        entry_setup: 'CONTINUATION',
        entry_regime: 'TREND_DOWN',
      })
    );

    const first = evaluatePendingWithNextSignal({
      account_id: 2,
      epic: 'GOLD',
      next_side: 'BUY',
      closedBars: strongBuyBars(),
      feed: feedStrong(),
      regime: 'TREND_UP',
    });
    const second = evaluatePendingWithNextSignal({
      account_id: 2,
      epic: 'GOLD',
      next_side: 'SELL',
      closedBars: strongSellBars(),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
