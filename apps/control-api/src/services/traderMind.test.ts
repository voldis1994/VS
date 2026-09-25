import { describe, expect, it } from 'vitest';
import { thinkLikeTrader, reviewSessionLikeHuman } from './traderMind.js';
import type { ManageBrainInput } from './manageBrain.js';

function base(partial: Partial<ManageBrainInput> = {}): ManageBrainInput {
  return {
    open_side: 'BUY',
    entry_price: 4330,
    mid: 4334,
    mfe: 5,
    mae: 0.5,
    unrealized: 4,
    peak_retention: 0.8,
    peak_protect_armed: true,
    entry_regime: 'TREND_UP',
    live_regime: 'TREND_UP',
    entry_setup: 'PULLBACK',
    soft_sl: 3.5,
    peak_mfe_floor: 6,
    peak_retention_cfg: 0.72,
    target_dist: 10,
    minute_policy: 'continue',
    soft_gate_allow: false,
    soft_gate_hold_reason: '',
    next_entry_side: 'BUY',
    session_expectancy_pts: 0.2,
    last_window_expectancy: 0.1,
    closes_in_session: 5,
    held_ms: 90_000,
    market: {
      at_ms: Date.now(),
      regime: 'TREND_UP',
      zone: { pos: 0.4, band: 'MID_LO', width: 12 },
      story: {
        chapter: 'RALLY',
        allow: 'BUY',
        red_1m: 8,
        green_1m: 18,
        swing: 'HH_HL',
        conf: 0.7,
        net_pts: 6,
      },
      pressure: {
        green_1m: 18,
        red_1m: 8,
        green_share: 0.69,
        last_body_sign: 1,
        last_body_pct: 0.0002,
        ticks: 6,
      },
      velocity: {
        last_body_pct: 0.0002,
        avg_range_pct: 0.00015,
        expanding: false,
        compressed: false,
        moving: true,
      },
      feed: { contributing: 3, agreement: 'STRONG' },
      summary: 'RALLY · zone MID_LO · G18/R8 · STEADY · feed STRONG',
    },
    ...partial,
  };
}

describe('traderMind', () => {
  it('HOLDs with human thesis when 1m continue and story with us', () => {
    const t = thinkLikeTrader(base());
    expect(t.decision).toBe('HOLD');
    expect(t.situation).toMatch(/BUY|pircējs/i);
    expect(t.thesis.length).toBeGreaterThan(20);
    expect(t.why.length).toBeGreaterThan(10);
    expect(t.spoken).toMatch(/^PRĀTS HOLD/);
  });

  it('BANKs like a human when green Soft and market turns', () => {
    const t = thinkLikeTrader(
      base({
        minute_policy: 'reverse',
        next_entry_side: 'SELL',
        unrealized: 4,
        mfe: 5,
        soft_sl: 3.5,
        market: {
          ...base().market!,
          story: {
            ...base().market!.story!,
            allow: 'SELL',
            chapter: 'SELLOFF',
          },
        },
      })
    );
    expect(t.decision).toBe('BANK');
    expect(t.why).toMatch(/Bankoju|peļņ/i);
  });

  it('reviews session with diagnosis — never suggests filters', () => {
    const lesson = reviewSessionLikeHuman([
      {
        pnl_pts: -2,
        exit_reason: 'HardInvalidation',
        mfe: 0.4,
        mae: 2,
        entry_ctx: { chapter: 'BOUNCE_IN_SELL' },
      },
      {
        pnl_pts: -1.8,
        exit_reason: 'HardInvalidation',
        mfe: 0.3,
        mae: 1.9,
        entry_ctx: { chapter: 'RANGE_CHOP' },
      },
      { pnl_pts: 0.3, exit_reason: 'PeakProtection', mfe: 4, mae: 0.5 },
      { pnl_pts: 0.2, exit_reason: 'PeakProtection', mfe: 3.5, mae: 0.4 },
      { pnl_pts: -1.5, exit_reason: 'HardInvalidation', mfe: 0.2, mae: 1.7 },
    ]);
    expect(lesson.diagnosis.length).toBeGreaterThan(10);
    expect(lesson.lesson).not.toMatch(/filtr/i);
    expect(['ease_peak_target', 'protect_sooner', 'hold_course', 'let_winners_run']).toContain(
      lesson.intent
    );
  });
});
