/**
 * Representative proofs: flip genome → live *decision* flips.
 * Not value-only; not 1:1 coverage of every mapped knob (see audit note).
 * Asserts the same functions desk/entry/auto-cal use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetBrainGenomeForTests, getBrainGenome } from '../brainSelfImprove/brainGenome.js';
import {
  tipChaseBlocksEntry,
  postImpulseTipBlocksEntry,
  structureGate,
  zoneGeometry,
} from './structureEntry.js';
import {
  effectivePeakKeep,
  softPlusDeepGiveback,
  softLossLearnerCutMfe,
} from './exitManage.js';
import { scoreManageAction, type ManageBrainInput } from './manageBrain.js';
import { thinkLikeTrader, thinkEntryLikeTrader } from './traderMind.js';
import { rejection1m } from './marketStory.js';
import { safetyAbsFloorForMid } from './robotDesk.js';
import {
  autoCalibrateEveryN,
  autoCalibrateWindowFromTrades,
  proposeAutoCalibration,
} from './autoCalibrate.js';
import { defaultDeskCalibration } from './deskCalibration.js';
import { _setEntryFilterLevelForTests } from './tradeOpenPolicy.js';
import { _resetLearnerForTests } from './deskLearner.js';
import { classifyRegime, MIN_BARS_FOR_ZONE } from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, t = 0, pad = 0.2): TenSecBar {
  return {
    open_time_ms: t,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad,
    close,
    ticks: 8,
  };
}

function vRecoveryBook(): { book: TenSecBar[]; tip: TenSecBar; pos: number } {
  const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 40 * 60_000;
  const book: TenSecBar[] = [];
  for (let i = 0; i < 60; i++) book.push(bar(4340, 4339.6, m0 + i * 10_000, 0.25));
  for (let i = 0; i < 60; i++) {
    const px = 4338 - i * 0.22;
    book.push(bar(px + 0.12, px, m0 + (60 + i) * 10_000, 0.15));
  }
  for (let i = 0; i < 60; i++) {
    const px = 4325 + i * 0.27;
    book.push(bar(px - 0.1, px, m0 + (120 + i) * 10_000, 0.15));
  }
  const tip = bar(4340.8, 4341.4, m0 + 180 * 10_000, 0.2);
  book.push(tip);
  const z = zoneGeometry(book, tip)!;
  return { book, tip, pos: z.pos };
}

function manageBase(partial: Partial<ManageBrainInput> = {}): ManageBrainInput {
  return {
    open_side: 'BUY',
    entry_price: 4330,
    mid: 4332,
    mfe: 5,
    mae: 0.4,
    unrealized: 4.2,
    peak_retention: 0.8,
    peak_protect_armed: false,
    entry_regime: 'TREND_UP',
    live_regime: 'TREND_UP',
    entry_setup: 'PULLBACK',
    soft_sl: 3.5,
    peak_mfe_floor: 6.5,
    peak_retention_cfg: 0.72,
    target_dist: 10,
    minute_policy: 'reverse',
    soft_gate_allow: true,
    soft_gate_hold_reason: '',
    next_entry_side: 'SELL',
    session_expectancy_pts: -0.4,
    last_window_expectancy: null,
    closes_in_session: 5,
    held_ms: 60_000,
    ...partial,
  };
}

describe('genome wire-cut proof — flip knob → live behavior flips', () => {
  beforeEach(() => {
    _resetBrainGenomeForTests({});
    _resetLearnerForTests(0);
  });
  afterEach(() => {
    _resetBrainGenomeForTests({});
    _setEntryFilterLevelForTests(null);
  });

  it('entry_tip_block_finished_move OFF → BUY@HI TREND_PULLBACK not tip-blocked', () => {
    expect(
      tipChaseBlocksEntry({
        liveRegime: 'TREND_UP',
        lane: 'TREND_PULLBACK',
        chapter: 'RALLY',
        side: 'BUY',
        zpos: 0.85,
        barSign: 1,
      })
    ).toBe(true);

    _resetBrainGenomeForTests({ entry_tip_block_finished_move: false });
    expect(
      tipChaseBlocksEntry({
        liveRegime: 'TREND_UP',
        lane: 'TREND_PULLBACK',
        chapter: 'MIXED',
        side: 'BUY',
        zpos: 0.85,
        barSign: 1,
      })
    ).toBe(false);
  });

  it('entry_tip_chase_trend_pullback OFF → true TREND lane skips tip knife', () => {
    _resetBrainGenomeForTests({ entry_tip_chase_trend_pullback: false });
    expect(
      tipChaseBlocksEntry({
        liveRegime: 'TREND_UP',
        lane: 'TREND_PULLBACK',
        chapter: 'MIXED',
        side: 'BUY',
        zpos: 0.9,
        barSign: 1,
      })
    ).toBe(false);
    expect(
      tipChaseBlocksEntry({
        liveRegime: 'RANGE',
        lane: 'RANGE_FADE',
        chapter: 'MIXED',
        side: 'BUY',
        zpos: 0.9,
        barSign: 1,
      })
    ).toBe(true);
  });

  it('struct_extreme_* moves RANGE_FADE chop tip knife (no literal 0.85)', () => {
    _resetBrainGenomeForTests({
      struct_extreme_hi: 0.9,
      struct_extreme_lo: 0.1,
      entry_tip_block_finished_move: false,
      exhaust_tip_chase_block: false,
    });
    expect(
      tipChaseBlocksEntry({
        liveRegime: 'RANGE',
        lane: 'RANGE_FADE',
        chapter: 'RANGE_CHOP',
        side: 'BUY',
        zpos: 0.86,
        barSign: 1,
      })
    ).toBe(false);
    expect(
      tipChaseBlocksEntry({
        liveRegime: 'RANGE',
        lane: 'RANGE_FADE',
        chapter: 'RANGE_CHOP',
        side: 'BUY',
        zpos: 0.92,
        barSign: 1,
      })
    ).toBe(true);
  });

  it('entry_block_post_impulse_tip OFF → V@HI BUY allowed; ON blocks', () => {
    const { book, pos } = vRecoveryBook();
    expect(pos).toBeGreaterThanOrEqual(0.8);
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'TREND_PULLBACK',
        barSign: 1,
      })
    ).toBe(true);

    _resetBrainGenomeForTests({ entry_block_post_impulse_tip: false });
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'TREND_PULLBACK',
        barSign: 1,
      })
    ).toBe(false);
  });

  it('entry_post_impulse_exempt_lanes [] = no exemptions (BREAKOUT not spared)', () => {
    const { book, pos } = vRecoveryBook();
    // Factory exempts BREAKOUT
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'BREAKOUT',
        barSign: 1,
      })
    ).toBe(false);

    _resetBrainGenomeForTests({ entry_post_impulse_exempt_lanes: [] });
    expect(getBrainGenome().entry_post_impulse_exempt_lanes).toEqual([]);
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'BREAKOUT',
        barSign: 1,
      })
    ).toBe(true);
  });

  it('entry_post_impulse_zone_bars Genome horizon (not getZoneBars)', () => {
    const { book, pos } = vRecoveryBook();
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'TREND_PULLBACK',
        barSign: 1,
      })
    ).toBe(true);
    // Genome horizon too short vs min_bars → function no-ops (not getZoneBars)
    _resetBrainGenomeForTests({ entry_post_impulse_zone_bars: 30, entry_post_impulse_min_bars: 40 });
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'TREND_PULLBACK',
        barSign: 1,
      })
    ).toBe(false);
  });

  it('entry_trend_tip_require_reject OFF → TREND_UP HI without dip OK', () => {
    _setEntryFilterLevelForTests(2);
    const m0 = Date.now();
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      book.push({
        open_time_ms: m0 + i * 10_000,
        open: 4330,
        high: i === 5 ? 4340 : 4330.3,
        low: i === 15 ? 4320 : 4329.7,
        close: 4330,
        ticks: 8,
      });
    }
    const hi = bar(4336.5, 4338, m0 + MIN_BARS_FOR_ZONE * 10_000);
    book.push(hi);
    const z = zoneGeometry(book, hi)!;
    const buy = { direction: 'BUY' as const, setup: 'CONTINUATION' as const, reason: 't' };
    expect(structureGate(buy, 'TREND_UP', hi, z, null, 'UP').ok).toBe(false);

    _resetBrainGenomeForTests({ entry_trend_tip_require_reject: false });
    expect(structureGate(buy, 'TREND_UP', hi, z, null, 'UP').ok).toBe(true);
  });

  it('peak_keep_genome_owns — genome can ease Keep below desk', () => {
    expect(effectivePeakKeep(0.9, 0.6)).toBe(0.6);
    _resetBrainGenomeForTests({ peak_keep_genome_owns: false });
    expect(effectivePeakKeep(0.9, 0.6)).toBe(0.9);
  });

  it('deep_giveback_offset / mind_cut_soft_mult move Soft+ / learner lines', () => {
    expect(softPlusDeepGiveback(0.69, 0.82, 0.12)).toBe(true);
    expect(softPlusDeepGiveback(0.71, 0.82, 0.12)).toBe(false);
    _resetBrainGenomeForTests({ deep_giveback_offset: 0.05 });
    expect(softPlusDeepGiveback(0.76, 0.82)).toBe(true);
    expect(softPlusDeepGiveback(0.78, 0.82)).toBe(false);

    expect(softLossLearnerCutMfe(1.5, 2.0, 0.75)).toBe(true);
    _resetBrainGenomeForTests({ mind_cut_soft_mult: 0.5 });
    expect(softLossLearnerCutMfe(1.0, 2.0)).toBe(true);
    expect(softLossLearnerCutMfe(0.9, 2.0)).toBe(false);
  });

  it('#1 auto_calibrate_every_n — window slice matches trigger cadence', () => {
    _resetBrainGenomeForTests({ auto_calibrate_every_n: 7 });
    expect(autoCalibrateEveryN()).toBe(7);
    const trades = Array.from({ length: 14 }, (_, i) => ({ i }));
    const win = autoCalibrateWindowFromTrades(trades);
    expect(win).toHaveLength(7);
    expect(win[0]!.i).toBe(7);
    expect(win[6]!.i).toBe(13);
  });

  it('manage_score_story_fight — score rises when Genome weight rises (decision path)', () => {
    // Quiet base so story-fight weight is not lost in score clamp.
    // reason string is PRĀTS thesis (LV) + E score — bits are internal; prove via score.
    const withFight = manageBase({
      minute_policy: 'wait',
      next_entry_side: null,
      session_expectancy_pts: 0,
      closes_in_session: 0,
      soft_gate_allow: false,
      unrealized: 1,
      mfe: 1.2,
      market: {
        summary: 'test',
        story: { allow: 'SELL', chapter: 'SELLOFF', conf: 0.8 },
        pressure: { green_1m: 2, red_1m: 2, green_share: 0.5 },
        velocity: { expanding: false, compressed: false, moving: false },
        feed: { agreement: 'OK' },
        zone: null,
      } as any,
    });
    _resetBrainGenomeForTests({ manage_score_story_fight: 0.2, manage_score_clamp: 5 });
    const lo = scoreManageAction(withFight);
    _resetBrainGenomeForTests({ manage_score_story_fight: 1.5, manage_score_clamp: 5 });
    const hi = scoreManageAction(withFight);
    expect(hi.score).toBeGreaterThan(lo.score);
    expect(hi.reason).toMatch(/E 1\.\d/);
    expect(Number(hi.reason.match(/E ([\d.]+)/)?.[1])).toBeGreaterThan(
      Number(lo.reason.match(/E ([\d.]+)/)?.[1])
    );
  });

  it('manage_score_near_target — higher Genome weight raises score at near-Target', () => {
    const near = manageBase({
      unrealized: 9,
      target_dist: 10,
      soft_gate_allow: true,
      minute_policy: 'wait',
      next_entry_side: null,
      session_expectancy_pts: 0,
      closes_in_session: 0,
      market: null,
    });
    _resetBrainGenomeForTests({ manage_score_near_target: 0.1, manage_score_clamp: 5 });
    const lo = scoreManageAction(near);
    _resetBrainGenomeForTests({ manage_score_near_target: 1.5, manage_score_clamp: 5 });
    const hi = scoreManageAction(near);
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  it('mind_manage_conf_bank — PRĀTS BANK confidence follows Genome', () => {
    const input = {
      open_side: 'BUY' as const,
      soft_sl: 2,
      mfe: 3,
      mae: 0.2,
      unrealized: 2.5,
      peak_retention: 0.7,
      minute_policy: 'reverse' as const,
      next_entry_side: 'SELL' as const,
      session_expectancy_pts: 0,
      closes_in_session: 3,
      market: {
        summary: 'x',
        story: { allow: 'SELL' as const, chapter: 'SELLOFF', conf: 0.8 },
        pressure: { green_1m: 1, red_1m: 4, green_share: 0.2 },
        velocity: { expanding: false, compressed: false, moving: true },
        feed: { agreement: 'OK' as const },
        zone: null,
      },
    };
    const a = thinkLikeTrader(input as any);
    expect(a.decision).toBe('BANK');
    expect(a.confidence).toBeCloseTo(0.88, 2);
    _resetBrainGenomeForTests({ mind_manage_conf_bank: 0.95 });
    const b = thinkLikeTrader(input as any);
    expect(b.decision).toBe('BANK');
    expect(b.confidence).toBeCloseTo(0.95, 2);
  });

  it('scalp_wick_frac — rejection1m decision flips with Genome', () => {
    // upper wick ≈ 0.524 — between factory 0.45 and sanitize-max-safe 0.75
    // (span=2.1, upper=(4331.1-4330)/2.1)
    const m1 = {
      open_time_ms: 0,
      open: 4330,
      high: 4331.1,
      low: 4329,
      close: 4330,
      bars: 6,
    };
    _resetBrainGenomeForTests({ scalp_wick_frac: 0.45 });
    expect(rejection1m(m1, 'SELL')).toBe(true);
    _resetBrainGenomeForTests({ scalp_wick_frac: 0.75 });
    expect(rejection1m(m1, 'SELL')).toBe(false);
  });

  it('safety_*_bp — abs floor for mid≈5 follows Genome tiny bp', () => {
    const mid = 5;
    const factory = safetyAbsFloorForMid(mid);
    expect(factory).toBeCloseTo(5 * 5 * 1e-4, 8); // tiny_bp=5
    _resetBrainGenomeForTests({ safety_abs_floor_tiny_bp: 10 });
    expect(safetyAbsFloorForMid(mid)).toBeCloseTo(5 * 10 * 1e-4, 8);
  });

  it('auto_cal_*_pct_bp — proposeAutoCalibration hardinv_pct floor follows Genome bp', () => {
    const base = {
      ...defaultDeskCalibration(),
      hardinv_abs: 0.5,
      hardinv_pct: 0.0002,
    };
    const window = Array.from({ length: 5 }, () => ({
      pnl_pts: 0.1,
      regime: 'TREND_UP',
      setup_type: 'PULLBACK',
      exit_reason: 'PeakProtection',
      mfe: 0.5,
      mae: 0,
      at: new Date().toISOString(),
      entry_ctx: null,
    }));
    _resetBrainGenomeForTests({ auto_cal_min_hardinv_pct_bp: 2 });
    const lo = proposeAutoCalibration(base, window as any, new Set());
    _resetBrainGenomeForTests({ auto_cal_min_hardinv_pct_bp: 20 });
    const hi = proposeAutoCalibration(base, window as any, new Set());
    expect(lo.next.hardinv_pct).toBeCloseTo(0.0002, 6);
    expect(hi.next.hardinv_pct).toBeGreaterThanOrEqual(0.002);
    expect(hi.next.hardinv_pct).toBeGreaterThan(lo.next.hardinv_pct);
  });

  it('local_breakout_clear_frac_mult — classifyRegime flips BREAKOUT↔EXPANSION', () => {
    // Wide 30m box (early dump) + quiet local shelf; tip pierce ~15% of shelf width.
    // low mult (0.2→frac≈0.05) fires local BREAKOUT_DOWN; high mult (1.0→frac=0.25) does not.
    const shelfLo = 4150;
    const shelfHi = 4156;
    const n = MIN_BARS_FOR_ZONE + 90;
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 35; i++) {
      const c = 4200 - (i / 34) * 80;
      bars.push({
        open_time_ms: i * 10_000,
        open: c,
        high: c + 0.5,
        low: c - 0.5,
        close: c,
        ticks: 10,
      });
    }
    for (let i = 35; i < 55; i++) {
      const c = 4120 + ((i - 35) / 19) * 33;
      bars.push({
        open_time_ms: i * 10_000,
        open: c,
        high: c + 0.4,
        low: c - 0.4,
        close: c,
        ticks: 10,
      });
    }
    for (let i = 55; i < n; i++) {
      const c = 4153 + ((i % 4) - 1.5) * 0.1;
      const touch = i % 11 === 0;
      bars.push({
        open_time_ms: i * 10_000,
        open: c,
        high: touch ? shelfHi : c + 0.12,
        low: touch ? shelfLo : c - 0.12,
        close: c,
        ticks: 10,
      });
    }
    const pierceFrac = 0.15;
    const close = shelfLo - pierceFrac * (shelfHi - shelfLo);
    bars.push({
      open_time_ms: n * 10_000,
      open: 4153,
      high: 4153.1,
      low: close - 0.05,
      close,
      ticks: 10,
    });

    _resetBrainGenomeForTests({
      local_breakout_clear_frac_mult: 0.2,
      local_breakout_frac_floor: 0.05,
    });
    expect(classifyRegime(bars, 'RANGE')).toBe('BREAKOUT_DOWN');
    _resetBrainGenomeForTests({
      local_breakout_clear_frac_mult: 1.0,
      local_breakout_frac_floor: 0.05,
    });
    expect(classifyRegime(bars, 'RANGE')).toBe('EXPANSION');
  });

  it('mind_entry_conf_pb_wait — bounce WAIT confidence follows Genome', () => {
    // m1 FLAT keeps stackSide=SELL (aligned DOWN); bounce branch uses pb_wait
    const input = {
      regime: 'RANGE',
      chapter: 'BOUNCE_IN_SELL',
      allow: 'SELL',
      story_conf: 0.85,
      red_1m: 14,
      green_1m: 6,
      zone_pos: 0.2,
      bar_body_sign: 1,
      m1_dir: 'FLAT' as const,
      bias: 'DOWN' as const,
      tf5_dir: 'DOWN' as const,
      tf15_dir: 'DOWN' as const,
      tf30_dir: 'DOWN' as const,
    };
    _resetBrainGenomeForTests({ mind_entry_conf_pb_wait: 0.45 });
    const a = thinkEntryLikeTrader(input);
    expect(a.choice).toBe('WAIT');
    expect(a.confidence).toBeCloseTo(0.45, 2);
    _resetBrainGenomeForTests({ mind_entry_conf_pb_wait: 0.72 });
    const b = thinkEntryLikeTrader(input);
    expect(b.choice).toBe('WAIT');
    expect(b.confidence).toBeCloseTo(0.72, 2);
  });

  it('mind_entry_conf_hard_veto — allow BUY blocks SELL at Genome conf', () => {
    const input = {
      regime: 'RANGE',
      chapter: 'RALLY',
      allow: 'BUY',
      story_conf: 0.9,
      red_1m: 4,
      green_1m: 2,
      zone_pos: 0.5,
      bar_body_sign: -1,
      m1_dir: 'DOWN' as const,
      bias: 'DOWN' as const,
      tf5_dir: 'DOWN' as const,
      tf15_dir: 'DOWN' as const,
      tf30_dir: 'DOWN' as const,
    };
    _resetBrainGenomeForTests({ mind_entry_conf_hard_veto: 0.3 });
    const a = thinkEntryLikeTrader(input);
    expect(a.choice).toBe('WAIT');
    expect(a.confidence).toBeCloseTo(0.3, 2);
    _resetBrainGenomeForTests({ mind_entry_conf_hard_veto: 0.55 });
    const b = thinkEntryLikeTrader(input);
    expect(b.choice).toBe('WAIT');
    expect(b.confidence).toBeCloseTo(0.55, 2);
  });

  it('entry_post_impulse_late_eff_min — own knob (trek_eff_min flip does not unblock)', () => {
    const { book, pos } = vRecoveryBook();
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'TREND_PULLBACK',
        barSign: 1,
      })
    ).toBe(true);
    // trek_eff_min is a different system — must not own post-impulse lateChop
    _resetBrainGenomeForTests({ trek_eff_min: 0.9 });
    expect(
      postImpulseTipBlocksEntry({
        closedBars: book,
        side: 'BUY',
        zpos: pos,
        lane: 'TREND_PULLBACK',
        barSign: 1,
      })
    ).toBe(true);
    _resetBrainGenomeForTests({ entry_post_impulse_late_eff_min: 0.85 });
    expect(getBrainGenome().entry_post_impulse_late_eff_min).toBe(0.85);
    expect(getBrainGenome().trek_eff_min).toBe(0.4);
  });

  it('auto_cal_peak_raise_abs / target_raise_abs — raise path step follows Genome', () => {
    const base = defaultDeskCalibration();
    // micro-wins vs Soft losses → let_winners_run / raise path
    const window = [
      {
        pnl_pts: 0.4,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'PeakProtection',
        mfe: 3.5,
        mae: -0.2,
        at: new Date().toISOString(),
        entry_ctx: null,
      },
      {
        pnl_pts: 0.5,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'PeakProtection',
        mfe: 4.0,
        mae: -0.1,
        at: new Date().toISOString(),
        entry_ctx: null,
      },
      {
        pnl_pts: -2.2,
        regime: 'RANGE',
        setup_type: 'FADE',
        exit_reason: 'HardInvalidation · Soft',
        mfe: 0.3,
        mae: -2.2,
        at: new Date().toISOString(),
        entry_ctx: null,
      },
      {
        pnl_pts: 0.3,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'PeakProtection',
        mfe: 2.8,
        mae: -0.2,
        at: new Date().toISOString(),
        entry_ctx: null,
      },
      {
        pnl_pts: -2.0,
        regime: 'RANGE',
        setup_type: 'FADE',
        exit_reason: 'HardInvalidation · Soft',
        mfe: 0.2,
        mae: -2.0,
        at: new Date().toISOString(),
        entry_ctx: null,
      },
    ];
    _resetBrainGenomeForTests({
      auto_cal_peak_raise_abs: 0.4,
      auto_cal_target_raise_abs: 0.8,
    });
    const lo = proposeAutoCalibration(base, window as any, new Set());
    _resetBrainGenomeForTests({
      auto_cal_peak_raise_abs: 1.5,
      auto_cal_target_raise_abs: 2.5,
    });
    const hi = proposeAutoCalibration(base, window as any, new Set());
    // When raise path fires, higher Genome steps → larger Peak/Target abs
    if (lo.next.peak_mfe_abs > base.peak_mfe_abs || hi.next.peak_mfe_abs > base.peak_mfe_abs) {
      expect(hi.next.peak_mfe_abs - base.peak_mfe_abs).toBeGreaterThanOrEqual(
        lo.next.peak_mfe_abs - base.peak_mfe_abs
      );
    }
    expect(getBrainGenome().auto_cal_peak_raise_abs).toBe(1.5);
    expect(getBrainGenome().auto_cal_target_raise_abs).toBe(2.5);
  });

  it('entry_learner_min_updates on Genome (factory 20) — wired like manage_learner', () => {
    expect(getBrainGenome().entry_learner_min_updates).toBe(20);
    _resetBrainGenomeForTests({ entry_learner_min_updates: 8 });
    expect(getBrainGenome().entry_learner_min_updates).toBe(8);
  });

  it('entry_post_impulse_zone_bars — sanitizer min 30, no consumer Math.max floor', () => {
    _resetBrainGenomeForTests({ entry_post_impulse_zone_bars: 30 });
    expect(getBrainGenome().entry_post_impulse_zone_bars).toBe(30);
    // Below sanitizer floor clamps up
    _resetBrainGenomeForTests({ entry_post_impulse_zone_bars: 10 as any });
    expect(getBrainGenome().entry_post_impulse_zone_bars).toBe(30);
  });
});
