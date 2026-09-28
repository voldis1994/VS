import { describe, expect, it, beforeEach } from 'vitest';
import { thinkLikeTrader, thinkEntryLikeTrader, reviewSessionLikeHuman } from './traderMind.js';
import type { ManageBrainInput } from './manageBrain.js';
import { _resetBrainGenomeForTests } from '../brainSelfImprove/brainGenome.js';

beforeEach(() => {
  _resetBrainGenomeForTests();
});

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

  it('BANKs Soft+ giveback even on 1m continue — plus before Soft eats it', () => {
    // Was: continue → HOLD forever → Soft later closed the winner as a minus
    const t = thinkLikeTrader(
      base({
        minute_policy: 'continue',
        unrealized: 4,
        mfe: 6,
        soft_sl: 3.5,
        peak_retention: 0.55, // giving back under Keep 75%
        next_entry_side: 'BUY',
      })
    );
    expect(t.decision).toBe('BANK');
    expect(t.why).toMatch(/plus|bankoju|Soft\+/i);
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

  it('ENTRY mind chooses SELL on selloff — not blind BUY fade', () => {
    const t = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.75,
      story_summary: 'STĀSTS · 30m selloff · tikai SELL · nepirkt',
      red_1m: 18,
      green_1m: 6,
      zone_pos: 0.4,
      bar_body_sign: 1,
      last_closed_side: 'BUY',
      last_close_was_loss: true,
      m1_dir: 'DOWN',
      bias: 'DOWN',
    });
    expect(t.choice).toBe('SELL');
    expect(t.spoken).toMatch(/PRĀTS ENTRY SELL/);
    expect(t.thesis).toMatch(/selloff|pārdevēj|leju|DOWN/i);
  });

  it('ENTRY mind chooses BUY on live 1m UP rally — never SELL fade', () => {
    const t = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'RANGE_CHOP',
      allow: 'BOTH',
      story_conf: 0.5,
      red_1m: 10,
      green_1m: 12,
      zone_pos: 0.7,
      bar_body_sign: 1,
      m1_dir: 'UP',
      m1_strong: true,
      bias: 'UP',
    });
    expect(t.choice).toBe('BUY');
    expect(t.thesis).toMatch(/augšu|pircēj|zaļ|UP|Steks/i);
    expect(t.choice).not.toBe('SELL');
  });

  it('ENTRY mind WAITs on chop instead of forcing a side', () => {
    const t = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'RANGE_CHOP',
      allow: 'NONE',
      story_conf: 0.35,
      red_1m: 10,
      green_1m: 10,
      zone_pos: 0.5,
      bar_body_sign: 0,
      m1_dir: 'FLAT',
      bias: 'FLAT',
    });
    expect(t.choice).toBe('WAIT');
  });

  it('ENTRY mind follows aligned Capital 30/15/5/1m UP stack', () => {
    const t = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'RANGE_CHOP',
      allow: 'BOTH',
      story_conf: 0.5,
      red_1m: 8,
      green_1m: 14,
      zone_pos: 0.55,
      bar_body_sign: 1,
      m1_dir: 'UP',
      bias: 'UP',
      tf5_dir: 'UP',
      tf15_dir: 'UP',
      tf30_dir: 'UP',
    });
    expect(t.choice).toBe('BUY');
    expect(t.spoken).toMatch(/30m↑ 15m↑ 5m↑ 1m↑/);
    expect(t.choice).not.toBe('SELL');
  });

  it('ENTRY mind never SELLs into aligned UP multi-TF (rally knife)', () => {
    const t = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.8,
      red_1m: 16,
      green_1m: 8,
      zone_pos: 0.4,
      bar_body_sign: -1,
      m1_dir: 'DOWN',
      bias: 'DOWN',
      tf5_dir: 'UP',
      tf15_dir: 'UP',
      tf30_dir: 'UP',
    });
    // 30/15 UP with 5m UP bias → stack UP; 1m DOWN is pullback — not a SELL
    expect(t.choice).not.toBe('SELL');
    expect(t.spoken).toMatch(/30m↑/);
  });

  it('ENTRY mind SELLs when full stack is DOWN', () => {
    const t = thinkEntryLikeTrader({
      regime: 'TREND_DOWN',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.8,
      red_1m: 18,
      green_1m: 5,
      zone_pos: 0.35,
      bar_body_sign: -1,
      m1_dir: 'DOWN',
      bias: 'DOWN',
      tf5_dir: 'DOWN',
      tf15_dir: 'DOWN',
      tf30_dir: 'DOWN',
    });
    expect(t.choice).toBe('SELL');
    expect(t.spoken).toMatch(/30m↓ 15m↓ 5m↓ 1m↓/);
  });

  it('ENTRY WAITs SELL into green 1m bounce — no Soft spam on bias DOWN', () => {
    const t = thinkEntryLikeTrader({
      regime: 'TREND_DOWN',
      chapter: 'BOUNCE_IN_SELL',
      allow: 'SELL',
      story_conf: 0.7,
      red_1m: 12,
      green_1m: 10,
      zone_pos: 0.4,
      bar_body_sign: 1,
      m1_dir: 'UP',
      m1_strong: true,
      bias: 'DOWN',
      tf5_dir: 'DOWN',
      tf15_dir: 'DOWN',
      tf30_dir: 'DOWN',
    });
    expect(t.choice).toBe('WAIT');
    expect(t.why).toMatch(/1m|bounce|Soft|trigger/i);
  });

  it('ENTRY WAITs same-side after Soft SELL without fresh 1m DOWN', () => {
    const t = thinkEntryLikeTrader({
      regime: 'TREND_DOWN',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.7,
      red_1m: 14,
      green_1m: 8,
      zone_pos: 0.4,
      bar_body_sign: 0,
      last_closed_side: 'SELL',
      last_close_was_loss: true,
      m1_dir: 'FLAT',
      bias: 'DOWN',
      tf5_dir: 'DOWN',
      tf15_dir: 'DOWN',
      tf30_dir: 'DOWN',
    });
    expect(t.choice).toBe('WAIT');
    expect(t.thesis).toMatch(/Soft|pašu pusi|spam/i);
  });
});
