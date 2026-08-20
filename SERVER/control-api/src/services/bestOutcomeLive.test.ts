import { describe, expect, it } from 'vitest';
import {
  evaluateBestOutcome,
  initBestOutcomeTrack,
  type ExitSnapshot,
} from './exitManage.js';
import {
  decideLiveBestOutcomeExit,
  resolveLiveManageSignal,
  type LiveManageSignal,
} from './bestOutcomeLive.js';
import { LIVE_CONFIRM_STRONG } from './bestOutcomeQuality.js';
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

function trendBars(side: 'BUY' | 'SELL', n = 10): TenSecBar[] {
  const out: TenSecBar[] = [];
  let p = 3300;
  for (let i = 0; i < n; i++) {
    const close = side === 'BUY' ? p + 2 : p - 2;
    out.push(bar(p, close));
    p = close;
  }
  return out;
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

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date().toISOString(),
    regime: 'TREND_UP',
    entry_setup: 'CONTINUATION',
    entry_regime: 'TREND_UP',
    ...partial,
  };
}

function profitLockCandidate(side: 'BUY' | 'SELL') {
  const entry = 2490;
  const track = initBestOutcomeTrack(entry);
  track.first_plus_at_ms = Date.now() - 60_000;
  if (side === 'BUY') {
    track.best_price_seen = 2496;
    track.max_profit_seen = 6;
    return evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 6, regime: 'TREND_UP' }),
      2493,
      { closedBars: [bar(2495, 2494), bar(2494, 2493)], trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
  }
  track.best_price_seen = 2484;
  track.max_profit_seen = 6;
  return evaluateBestOutcome(
    snap({
      open_side: 'SELL',
      entry_price: entry,
      mfe: 6,
      regime: 'TREND_DOWN',
      entry_regime: 'TREND_DOWN',
    }),
    2487,
    { closedBars: [bar(2485, 2486), bar(2486, 2487)], trend_bias: 'DOWN', regime: 'TREND_DOWN' },
    track
  );
}

function breakevenAtZeroCandidate(side: 'BUY' | 'SELL') {
  const entry = 2490;
  const track = initBestOutcomeTrack(entry);
  track.max_profit_seen = 3;
  track.first_plus_at_ms = Date.now() - 60_000;
  if (side === 'SELL') {
    track.best_price_seen = 2487;
    return evaluateBestOutcome(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        mfe: 3,
        regime: 'TREND_DOWN',
        entry_regime: 'TREND_DOWN',
      }),
      2490,
      { closedBars: [bar(2488, 2489), bar(2489, 2490)], trend_bias: 'DOWN', regime: 'TREND_DOWN' },
      track
    );
  }
  track.best_price_seen = 2493;
  return evaluateBestOutcome(
    snap({ open_side: 'BUY', entry_price: entry, mfe: 3, regime: 'TREND_UP' }),
    2490,
    { closedBars: [bar(2492, 2491), bar(2491, 2490)], trend_bias: 'UP', regime: 'TREND_UP' },
    track
  );
}

function thesisFailureCandidate() {
  const entry = 2490;
  const track = initBestOutcomeTrack(entry);
  return evaluateBestOutcome(
    snap({
      open_side: 'SELL',
      entry_price: entry,
      mfe: 0,
      entry_setup: 'CONTINUATION',
      entry_regime: 'TREND_DOWN',
      regime: 'TREND_UP',
    }),
    2490.2,
    { closedBars: [bar(2490, 2490.2)], trend_bias: 'UP', regime: 'TREND_UP' },
    track
  );
}

function validSignal(side: 'BUY' | 'SELL'): LiveManageSignal {
  return {
    direction: side,
    setup: 'CONTINUATION',
    reason: `valid ${side}`,
    valid: true,
    peeked_pending_calc: true,
    consumed_pending_calc: false,
  };
}

function noSignal(): LiveManageSignal {
  return {
    direction: null,
    setup: null,
    reason: 'none',
    valid: false,
    peeked_pending_calc: false,
    consumed_pending_calc: false,
  };
}

describe('LIVE Best Outcome exit gate', () => {
  it('optimization candidate is tagged OPTIMIZATION', () => {
    const c = profitLockCandidate('SELL');
    expect(c.exit).toBe(true);
    expect(c.exit_kind).toBe('OPTIMIZATION');
  });

  it('OPEN SELL + strong current SELL confirmation → HOLD', () => {
    const candidate = profitLockCandidate('SELL');
    expect(candidate.exit).toBe(true);
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'SELL',
      mfe: 6,
      upl: 3,
      signal: validSignal('SELL'),
      closedBars: trendBars('SELL'),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(live.live_quality.next_signal_direction).toBe(-1);
    expect(live.live_quality.next_signal_confirm!).toBeGreaterThanOrEqual(LIVE_CONFIRM_STRONG);
    expect(live.exit).toBe(false);
    expect(live.action).toBe('HOLD');
    expect(live.live_overridden).toBe(true);
    expect(live.reason).toMatch(/LIVE HOLD/);
  });

  it('OPEN SELL + strong current BUY confirmation → CLOSE', () => {
    const candidate = profitLockCandidate('SELL');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'SELL',
      mfe: 6,
      upl: 3,
      signal: validSignal('BUY'),
      closedBars: trendBars('BUY'),
      feed: feedStrong(),
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(live.live_quality.next_signal_direction).toBe(1);
    expect(live.live_quality.next_signal_confirm!).toBeGreaterThanOrEqual(LIVE_CONFIRM_STRONG);
    expect(live.exit).toBe(true);
    expect(live.action).toBe('CLOSE');
    expect(live.reason).toMatch(/LIVE CLOSE/);
  });

  it('OPEN BUY + strong current BUY confirmation → HOLD', () => {
    const candidate = profitLockCandidate('BUY');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'BUY',
      mfe: 6,
      upl: 3,
      signal: validSignal('BUY'),
      closedBars: trendBars('BUY'),
      feed: feedStrong(),
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(live.live_quality.next_signal_direction).toBe(-1);
    expect(live.exit).toBe(false);
    expect(live.action).toBe('HOLD');
  });

  it('OPEN BUY + strong current SELL confirmation → CLOSE', () => {
    const candidate = profitLockCandidate('BUY');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'BUY',
      mfe: 6,
      upl: 3,
      signal: validSignal('SELL'),
      closedBars: trendBars('SELL'),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(live.live_quality.next_signal_direction).toBe(1);
    expect(live.exit).toBe(true);
    expect(live.action).toBe('CLOSE');
  });

  it('weak/neutral confirmation keeps original MFE/UPL CLOSE', () => {
    const candidate = profitLockCandidate('SELL');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'SELL',
      mfe: 6,
      upl: 3,
      signal: validSignal('SELL'),
      closedBars: null,
      feed: null,
      regime: 'RANGE',
      bias: 'FLAT',
    });
    expect(live.live_quality.next_signal_confirm!).toBeLessThan(LIVE_CONFIRM_STRONG);
    expect(live.exit).toBe(true);
    expect(live.action).toBe('CLOSE');
    expect(live.live_overridden).toBe(false);
  });

  it('no valid live signal keeps original CLOSE', () => {
    const candidate = profitLockCandidate('SELL');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'SELL',
      mfe: 6,
      upl: 3,
      signal: noSignal(),
      closedBars: trendBars('SELL'),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(live.live_quality.next_signal_direction).toBe(0);
    expect(live.exit).toBe(true);
    expect(live.action).toBe('CLOSE');
    expect(live.live_overridden).toBe(false);
  });

  it('SELL CLOSE at ~0 + strong SELL confirmation → HOLD (no churn)', () => {
    const candidate = breakevenAtZeroCandidate('SELL');
    expect(candidate.exit).toBe(true);
    expect(candidate.exit_kind).toBe('OPTIMIZATION');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'SELL',
      mfe: 3,
      upl: 0,
      signal: validSignal('SELL'),
      closedBars: trendBars('SELL'),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(live.exit).toBe(false);
    expect(live.action).toBe('HOLD');
    expect(live.live_overridden).toBe(true);
  });

  it('hard safety/risk EXIT is not blocked by strong same-direction confirm', () => {
    const candidate = thesisFailureCandidate();
    expect(candidate.exit).toBe(true);
    expect(candidate.exit_kind).toBe('HARD_SAFETY');
    const live = decideLiveBestOutcomeExit({
      candidate,
      openSide: 'SELL',
      mfe: 0,
      upl: -0.2,
      signal: validSignal('SELL'),
      closedBars: trendBars('SELL'),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(live.exit).toBe(true);
    expect(live.action).toBe('CLOSE');
    expect(live.live_overridden).toBe(false);
  });

  it('BUY/SELL live gate is symmetric', () => {
    const sellHold = decideLiveBestOutcomeExit({
      candidate: profitLockCandidate('SELL'),
      openSide: 'SELL',
      mfe: 6,
      upl: 3,
      signal: validSignal('SELL'),
      closedBars: trendBars('SELL'),
      feed: feedStrong(),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    const buyHold = decideLiveBestOutcomeExit({
      candidate: profitLockCandidate('BUY'),
      openSide: 'BUY',
      mfe: 6,
      upl: 3,
      signal: validSignal('BUY'),
      closedBars: trendBars('BUY'),
      feed: feedStrong(),
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(sellHold.action).toBe(buyHold.action);
    expect(sellHold.live_quality.next_signal_direction).toBe(buyHold.live_quality.next_signal_direction);
    expect(sellHold.live_overridden).toBe(buyHold.live_overridden);
  });

  it('BO formula is computed LIVE before CLOSE (score present on OPEN position)', () => {
    const live = decideLiveBestOutcomeExit({
      candidate: profitLockCandidate('SELL'),
      openSide: 'SELL',
      mfe: 6,
      upl: 3,
      signal: validSignal('BUY'),
      closedBars: trendBars('BUY'),
      feed: feedStrong(),
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(live.exit).toBe(true);
    expect(live.live_quality.retention).toBeCloseTo(0.5, 6);
    expect(live.live_quality.best_outcome_score).not.toBeNull();
    expect(Number.isFinite(live.live_quality.best_outcome_score!)).toBe(true);
  });
});

describe('LIVE manage signal — no new order', () => {
  it('valid pending SELL is peeked, never consumed', () => {
    const bars = trendBars('SELL');
    const pending = {
      direction: 'SELL' as const,
      setup_type: 'CONTINUATION',
      at: new Date().toISOString(),
    };
    const sig = resolveLiveManageSignal({
      pendingCalc: pending,
      bar: bars[bars.length - 1],
      closedBars: bars,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: bars[bars.length - 1]!.close,
      refs: [],
    });
    expect(sig.consumed_pending_calc).toBe(false);
    expect(sig.peeked_pending_calc).toBe(true);
    expect(pending.direction).toBe('SELL');
  });

  it('stale pending signal is not used as current valid direction', () => {
    const bars = trendBars('SELL');
    const sig = resolveLiveManageSignal({
      pendingCalc: {
        direction: 'BUY',
        setup_type: 'CONTINUATION',
        at: new Date(Date.now() - 20_000).toISOString(),
      },
      bar: bars[bars.length - 1],
      closedBars: bars,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: bars[bars.length - 1]!.close,
      refs: [],
    });
    expect(sig.peeked_pending_calc).toBe(true);
    expect(sig.consumed_pending_calc).toBe(false);
    expect(sig.direction).not.toBe('BUY');
  });

  it('blocked/invalid live signal is not valid', () => {
    const bars = trendBars('SELL');
    const sig = resolveLiveManageSignal({
      pendingCalc: {
        direction: 'BUY',
        setup_type: 'CONTINUATION',
        at: new Date().toISOString(),
      },
      bar: bars[bars.length - 1],
      closedBars: bars,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: bars[bars.length - 1]!.close,
      refs: [],
    });
    expect(sig.valid).toBe(false);
    expect(sig.consumed_pending_calc).toBe(false);
  });
});
