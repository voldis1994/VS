/**
 * Regime-as-context architecture — deterministic matrix.
 * Regime alone NEVER enters. Evidence required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateStrategy } from './strategyCore.js';
import { disableStrategyEvalLogForTests } from './strategyEvalLog.js';
import { effectiveRegimeName } from '../services/robotDesk.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';

function bar(open: number, close: number, t = 0): TenSecBar {
  const high = Math.max(open, close) + 0.8;
  const low = Math.min(open, close) - 0.4;
  return { open_time_ms: t, open, high, low, close, ticks: 12 };
}

/** Truly quiet — no artificial wick that looks like a move */
function quietBar(px = 2000, t = 0): TenSecBar {
  return { open_time_ms: t, open: px, high: px + 0.01, low: px - 0.01, close: px + 0.005, ticks: 4 };
}

function climb(n = 8, start = 2000, step = 0.5): TenSecBar[] {
  const out: TenSecBar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    out.push(bar(px, px + step, i + 1));
    px += step;
  }
  return out;
}

function dump(n = 8, start = 2000, step = 0.5): TenSecBar[] {
  const out: TenSecBar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    out.push(bar(px, px - step, i + 1));
    px -= step;
  }
  return out;
}

const base = {
  epic: 'GOLD',
  market_snapshot_id: 'ctx',
  market_open: true,
  feed_fresh: true,
  trading_enabled: true,
} as const;

describe('REGIME_CONTEXT_ARCHITECTURE', () => {
  beforeEach(() => disableStrategyEvalLogForTests(true));

  it('TREND + no setup → NO_SETUP', () => {
    const q = quietBar();
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: q,
      bars: [quietBar(2000, 1), quietBar(2000, 2), q],
      regime: 'TREND_UP',
    });
    expect(d.code).toBe('NO_SETUP');
    expect(d.reason).toMatch(/No valid setup/i);
  });

  it('TREND + valid pullback → ENTER_LONG', () => {
    // Mild climb (not exhaustion-sized) then small dip-buy
    const bars = [
      bar(2000, 2000.3, 1),
      bar(2000.3, 2000.55, 2),
      bar(2000.55, 2000.7, 3),
      bar(2000.7, 2000.85, 4),
    ];
    const dipBar = bar(2000.85, 2000.5, 5); // soft dip, not exhaustion confirm after large impulse
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: dipBar,
      bars: [...bars, dipBar],
      regime: 'TREND_UP',
    });
    expect(d.code).toBe('ENTER_LONG');
    expect(d.setup_type).toBe('PULLBACK');
  });

  it('RANGE + no evidence → NO_SETUP', () => {
    const flat = [quietBar(2000, 1), quietBar(2000.02, 2), quietBar(2000.01, 3)];
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: flat[2]!,
      bars: flat,
      regime: 'RANGE',
    });
    expect(d.code).toBe('NO_SETUP');
    expect(d.reason).not.toMatch(/forbidden/i);
  });

  it('RANGE + valid upper rejection → ENTER_SHORT', () => {
    const prior: TenSecBar[] = [
      { open_time_ms: 1, open: 2000, high: 2002, low: 1998, close: 2000.5, ticks: 10 },
      { open_time_ms: 2, open: 2000.5, high: 2001.8, low: 1998.2, close: 1999.5, ticks: 10 },
      { open_time_ms: 3, open: 1999.5, high: 2002.0, low: 1998.5, close: 2001.2, ticks: 10 },
      { open_time_ms: 4, open: 2001.2, high: 2002.1, low: 1999.0, close: 2000.0, ticks: 10 },
    ];
    const confirm: TenSecBar = {
      open_time_ms: 5,
      open: 2001.5,
      high: 2002.05,
      low: 1999.2,
      close: 1999.5,
      ticks: 12,
    };
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: confirm,
      bars: [...prior, confirm],
      regime: 'RANGE',
    });
    expect(d.code).toBe('ENTER_SHORT');
    expect(d.setup_type).toBe('RANGE_REJECTION');
  });

  it('FAILED_BREAKOUT + no confirmation → NO_SETUP', () => {
    const bars = climb(5);
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: bars[bars.length - 1]!,
      bars,
      regime: 'FAILED_BREAKOUT_UP',
    });
    expect(d.code).toBe('NO_SETUP');
  });

  it('FAILED_BREAKOUT + valid confirmation → ENTER_SHORT', () => {
    const prior: TenSecBar[] = [
      { open_time_ms: 1, open: 2000, high: 2002, low: 1998, close: 2000, ticks: 8 },
      { open_time_ms: 2, open: 2000, high: 2001.5, low: 1998.5, close: 2001, ticks: 8 },
      { open_time_ms: 3, open: 2001, high: 2002, low: 1999, close: 2000.5, ticks: 8 },
    ];
    const confirm: TenSecBar = {
      open_time_ms: 4,
      open: 2001.8,
      high: 2002.2,
      low: 1999.5,
      close: 1999.8,
      ticks: 12,
    };
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: confirm,
      bars: [...prior, confirm],
      regime: 'FAILED_BREAKOUT_UP',
    });
    expect(d.code).toBe('ENTER_SHORT');
    expect(d.setup_type).toBe('FAILED_BREAKOUT');
  });

  it('REVERSAL_CANDIDATE + no confirmation → NO_SETUP', () => {
    const bars = [quietBar(2000, 1), quietBar(2000.02, 2), quietBar(2000.01, 3)];
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: bars[2]!,
      bars,
      regime: 'REVERSAL_CANDIDATE',
    });
    expect(d.code).toBe('NO_SETUP');
  });

  it('REVERSAL_CANDIDATE + confirmed reversal → ENTER (FADE or REVERSAL setup family)', () => {
    // Mild prior climb (below exhaustion large-move thresholds) then rejection
    const bars = [
      bar(2000, 2000.4, 1),
      bar(2000.4, 2000.75, 2),
      bar(2000.75, 2001.0, 3),
      bar(2001.0, 2001.25, 4),
    ];
    // priorNet ~0.0006+, persist up, confirm red below prev — REVERSAL without FADE impulse body
    const confirm = bar(2001.25, 2000.4, 5);
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: confirm,
      bars: [...bars, confirm],
      regime: 'REVERSAL_CANDIDATE',
    });
    expect(d.code).toBe('ENTER_SHORT');
    expect(['REVERSAL', 'FADE']).toContain(d.setup_type);
  });

  it('EXHAUSTION + valid FADE → FADE survives Strategy', () => {
    const impulse = bar(2000, 2004);
    const confirm = bar(2004, 2001.5);
    const bars = [...climb(6, 1996, 0.4), impulse, confirm];
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: confirm,
      bars,
      regime: 'RANGE',
    });
    expect(d.code).toBe('ENTER_SHORT');
    expect(d.setup).toBe('FADE');
  });

  it('UNKNOWN + valid evidence → may ENTER', () => {
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: bar(2000, 1996),
      bars: dump(5),
      regime: 'UNKNOWN',
    });
    expect(d.code).toBe('ENTER_SHORT');
  });

  it('UNKNOWN + no evidence → NO_SETUP', () => {
    const q = quietBar();
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: q,
      bars: [quietBar(2000, 1), quietBar(2000, 2), q],
      regime: 'UNKNOWN',
    });
    expect(d.code).toBe('NO_SETUP');
  });

  it('regime alone → NEVER ENTER (no closed bar)', () => {
    const d = evaluateStrategy({
      ...base,
      bar_closed: false,
      closed_bar: null,
      bars: climb(5),
      regime: 'TREND_UP',
    });
    expect(d.code).toBe('NO_SETUP');
  });

  it('late_move invalidates setup as NO_SETUP not BLOCKED_TECHNICAL', () => {
    const bars = [
      bar(2000, 2000.3, 1),
      bar(2000.3, 2000.55, 2),
      bar(2000.55, 2000.7, 3),
      bar(2000.7, 2000.85, 4),
    ];
    const dipBar = bar(2000.85, 2000.5, 5);
    const d = evaluateStrategy({
      ...base,
      bar_closed: true,
      closed_bar: dipBar,
      bars: [...bars, dipBar],
      regime: 'TREND_UP',
      late_move: true,
    });
    expect(d.code).toBe('NO_SETUP');
    expect(d.invalidation_reason).toBe('LATE_MOVE');
    expect(d.block_reason).toBeUndefined();
  });

  it('bias does not rewrite UNKNOWN regime', () => {
    expect(effectiveRegimeName({ regime: 'UNKNOWN', trend_bias: 'UP' })).toBe('UNKNOWN');
    expect(effectiveRegimeName({ regime: 'UNKNOWN', trend_bias: 'DOWN' })).toBe('UNKNOWN');
  });

  it('same MarketState → same Strategy decision (idempotent authority)', () => {
    const bars = [
      bar(2000, 2000.3, 1),
      bar(2000.3, 2000.55, 2),
      bar(2000.55, 2000.7, 3),
      bar(2000.7, 2000.85, 4),
    ];
    const dipBar = bar(2000.85, 2000.5, 5);
    const input = {
      ...base,
      market_snapshot_id: 'same',
      bar_closed: true as const,
      closed_bar: dipBar,
      bars: [...bars, dipBar],
      regime: 'TREND_UP',
    };
    const a = evaluateStrategy(input);
    const b = evaluateStrategy(input);
    expect(a.code).toBe(b.code);
    expect(a.direction).toBe(b.direction);
    expect(a.setup_type).toBe(b.setup_type);
  });
});
