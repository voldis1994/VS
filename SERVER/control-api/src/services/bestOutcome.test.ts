import { describe, expect, it } from 'vitest';
import {
  evaluateBestOutcome,
  initBestOutcomeTrack,
  type ExitSnapshot,
} from './exitManage.js';
import type { TenSecBar } from './tenSecondOhlc.js';

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

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    // Aged entry so 30s plus-hold window has already elapsed for CLOSE tests.
    entry_at: new Date(Date.now() - 60_000).toISOString(),
    regime: 'TREND_UP',
    entry_setup: 'CONTINUATION',
    entry_regime: 'TREND_UP',
    ...partial,
  };
}

describe('Best Outcome — open position manage', () => {
  it('BUY continues rising -> HOLD', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    const bars = [bar(2490, 2491), bar(2491, 2492), bar(2492, 2493)];
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 3, regime: 'TREND_UP' }),
      2493,
      { closedBars: bars, trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(r.exit).toBe(false);
    expect(r.action).toBe('HOLD');
    expect(['HOLD', 'TRACKING']).toContain(r.track.state);
  });

  it('SELL continues falling -> HOLD', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    const bars = [bar(2490, 2489), bar(2489, 2488), bar(2488, 2487)];
    const r = evaluateBestOutcome(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        mfe: 3,
        regime: 'TREND_DOWN',
        entry_regime: 'TREND_DOWN',
      }),
      2487,
      { closedBars: bars, trend_bias: 'DOWN', regime: 'TREND_DOWN' },
      track
    );
    expect(r.exit).toBe(false);
    expect(r.action).toBe('HOLD');
  });

  it('small pullback on BUY -> HOLD (single adverse 10s)', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.max_profit_seen = 4;
    track.best_price_seen = 2494;
    const bars = [bar(2492, 2493), bar(2493, 2494), bar(2494, 2493.2)];
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 4, peak_retention: 0.8, regime: 'TREND_UP' }),
      2493.2,
      { closedBars: bars, trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(r.exit).toBe(false);
    expect(r.action).toBe('HOLD');
    expect(r.track.state).not.toBe('EXIT');
  });

  it('new best price updates best outcome track', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 5 }),
      2495,
      { closedBars: [bar(2493, 2494), bar(2494, 2495)], trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(r.view.best_price_seen).toBe(2495);
    expect(r.view.max_profit_seen).toBeGreaterThanOrEqual(5);
  });

  it('one bad 10s candle alone -> not EXIT', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2494;
    track.max_profit_seen = 4;
    const bars = [bar(2493, 2494), bar(2494, 2493)];
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 4, regime: 'TREND_UP' }),
      2493,
      { closedBars: bars, trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(r.exit).toBe(false);
    expect(r.action).toBe('HOLD');
  });

  it('trend resumes after pullback -> HOLD', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2494;
    track.max_profit_seen = 4;
    const bars = [bar(2494, 2493), bar(2493, 2493.5), bar(2493.5, 2494.2)];
    const r = evaluateBestOutcome(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 4,
        entry_regime: 'TREND_UP',
        regime: 'TREND_UP',
      }),
      2494.2,
      { closedBars: bars, trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(r.exit).toBe(false);
    expect(r.action).toBe('HOLD');
    expect(r.track.reason).toMatch(/hold|resume/i);
  });

  it('confirmed reversal on BUY -> EXIT', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2495;
    track.max_profit_seen = 5;
    track.first_plus_at_ms = Date.now() - 60_000;
    const bars = [bar(2494, 2493), bar(2493, 2492), bar(2492, 2491)];
    const r = evaluateBestOutcome(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 5,
        peak_retention: 0.2,
        entry_setup: 'CONTINUATION',
        entry_regime: 'TREND_UP',
        regime: 'TREND_DOWN',
      }),
      2491,
      { closedBars: bars, trend_bias: 'DOWN', regime: 'TREND_DOWN' },
      track
    );
    expect(r.exit).toBe(true);
    expect(r.action).toBe('CLOSE');
    expect(r.track.state).toBe('EXIT');
  });

  it('BUY and SELL behave symmetrically on continuation', () => {
    const buy = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 2 }),
      2002,
      { closedBars: [bar(2000, 2001), bar(2001, 2002)], trend_bias: 'UP', regime: 'TREND_UP' },
      initBestOutcomeTrack(2000)
    );
    const sell = evaluateBestOutcome(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        mfe: 2,
        regime: 'TREND_DOWN',
        entry_regime: 'TREND_DOWN',
      }),
      1998,
      {
        closedBars: [bar(2000, 1999), bar(1999, 1998)],
        trend_bias: 'DOWN',
        regime: 'TREND_DOWN',
      },
      initBestOutcomeTrack(2000)
    );
    expect(buy.exit).toBe(false);
    expect(sell.exit).toBe(false);
    expect(buy.view.current_profit).toBeGreaterThan(0);
    expect(sell.view.current_profit).toBeGreaterThan(0);
  });

  it('separate tracks for two positions do not cross-contaminate', () => {
    const trackA = initBestOutcomeTrack(2490);
    const trackB = initBestOutcomeTrack(4300);
    const a = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: 2490, mfe: 2 }),
      2492,
      { closedBars: [bar(2490, 2492)], trend_bias: 'UP', regime: 'TREND_UP' },
      trackA
    );
    const b = evaluateBestOutcome(
      snap({ open_side: 'SELL', entry_price: 4300, mfe: 1, entry_regime: 'TREND_DOWN', regime: 'TREND_DOWN' }),
      4299,
      { closedBars: [bar(4300, 4299)], trend_bias: 'DOWN', regime: 'TREND_DOWN' },
      trackB
    );
    expect(a.view.best_price_seen).toBe(2492);
    expect(b.view.best_price_seen).toBe(4299);
    expect(a.track).not.toBe(b.track);
  });

  it('robot cycle preserves Best Outcome track across evaluations', () => {
    const entry = 2490;
    let track = initBestOutcomeTrack(entry);
    const s = snap({ open_side: 'BUY', entry_price: entry, mfe: 2, regime: 'TREND_UP' });
    const c1 = evaluateBestOutcome(
      s,
      2492,
      { closedBars: [bar(2490, 2491), bar(2491, 2492)], trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    track = c1.track;
    const c2 = evaluateBestOutcome(
      { ...s, mfe: 4 },
      2494,
      { closedBars: [bar(2492, 2493), bar(2493, 2494)], trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(c2.view.best_price_seen).toBe(2494);
    expect(c2.view.max_profit_seen).toBeGreaterThanOrEqual(4);
    expect(c2.track.state).not.toBe('EXIT');
  });

  it('75% profit lock CLOSE when giveback exceeds 25% of MFE', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2496;
    track.max_profit_seen = 6;
    track.first_plus_at_ms = Date.now() - 60_000;
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 6, regime: 'TREND_UP' }),
      2493,
      { closedBars: [bar(2495, 2494), bar(2494, 2493)], trend_bias: 'UP', regime: 'TREND_UP' },
      track
    );
    expect(r.exit).toBe(true);
    expect(r.action).toBe('CLOSE');
    expect(r.reason).toMatch(/profit lock 75%/);
  });

  it('breakeven guard CLOSE when was in profit and UPL goes flat/negative', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.max_profit_seen = 3;
    track.first_plus_at_ms = Date.now() - 60_000;
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 3, regime: 'TREND_UP' }),
      2490,
      { closedBars: [bar(2492, 2491), bar(2491, 2490)], trend_bias: 'DOWN', regime: 'TREND_DOWN' },
      track
    );
    expect(r.exit).toBe(true);
    expect(r.action).toBe('CLOSE');
    expect(r.reason).toMatch(/breakeven guard/);
  });

  it('SELL symmetric 75% profit lock CLOSE', () => {
    const entry = 2490;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2484;
    track.max_profit_seen = 6;
    track.first_plus_at_ms = Date.now() - 60_000;
    const r = evaluateBestOutcome(
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
    expect(r.exit).toBe(true);
    expect(r.action).toBe('CLOSE');
    expect(r.reason).toMatch(/profit lock 75%/);
  });

  it('within 30s of first plus — profit lock stays HOLD', () => {
    const entry = 2490;
    const now = 1_000_000;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2496;
    track.max_profit_seen = 6;
    track.first_plus_at_ms = now - 5_000;
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 6, regime: 'TREND_UP' }),
      2493,
      { closedBars: [bar(2495, 2494), bar(2494, 2493)], trend_bias: 'UP', regime: 'TREND_UP' },
      track,
      { nowMs: now }
    );
    expect(r.exit).toBe(false);
    expect(r.action).toBe('HOLD');
    expect(r.reason).toMatch(/plus hold/i);
    expect(r.track.first_plus_at_ms).toBe(now - 5_000);
  });

  it('records first_plus_at_ms when UPL first goes positive', () => {
    const entry = 2490;
    const now = 2_000_000;
    const track = initBestOutcomeTrack(entry);
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 0, regime: 'TREND_UP' }),
      2491,
      { closedBars: [bar(2490, 2491)], trend_bias: 'UP', regime: 'TREND_UP' },
      track,
      { nowMs: now }
    );
    expect(r.exit).toBe(false);
    expect(r.track.first_plus_at_ms).toBe(now);
  });

  it('after 30s plus hold — profit lock may CLOSE', () => {
    const entry = 2490;
    const now = 1_000_000;
    const track = initBestOutcomeTrack(entry);
    track.best_price_seen = 2496;
    track.max_profit_seen = 6;
    track.first_plus_at_ms = now - 30_000;
    const r = evaluateBestOutcome(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 6, regime: 'TREND_UP' }),
      2493,
      { closedBars: [bar(2495, 2494), bar(2494, 2493)], trend_bias: 'UP', regime: 'TREND_UP' },
      track,
      { nowMs: now }
    );
    expect(r.exit).toBe(true);
    expect(r.action).toBe('CLOSE');
    expect(r.reason).toMatch(/profit lock/i);
  });
});
