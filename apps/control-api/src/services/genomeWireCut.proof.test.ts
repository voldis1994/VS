/**
 * Proof: cutting hardcode wires — flip genome → live behavior flips.
 * Not comment-only: each assert reads the same functions desk/entry use.
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
import { _setEntryFilterLevelForTests } from './tradeOpenPolicy.js';
import { MIN_BARS_FOR_ZONE } from './regimes.js';
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

describe('genome wire-cut proof — flip knob → behavior flips', () => {
  beforeEach(() => _resetBrainGenomeForTests({}));
  afterEach(() => _resetBrainGenomeForTests({}));

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
    // RALLY+BUY@tipHi still blocked by chapter rule — use MIXED at tip
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
    // RANGE_FADE still applies
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
    // Isolate chop-extreme path: finished-move tip OFF so exhaust_pos_hi does not mask
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

  it('entry_post_impulse_exempt_lanes genome — TREND_PULLBACK can be exempted', () => {
    const { book, pos } = vRecoveryBook();
    _resetBrainGenomeForTests({
      entry_post_impulse_exempt_lanes: ['BREAKOUT', 'REVERSAL', 'TREND_PULLBACK'],
    });
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
    _setEntryFilterLevelForTests(2); // structure gates armed
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
    const hi = bar(4336.5, 4338, m0 + MIN_BARS_FOR_ZONE * 10_000); // rally, not dip
    book.push(hi);
    const z = zoneGeometry(book, hi)!;
    expect(z.pos).toBeGreaterThanOrEqual(0.85);
    const buy = { direction: 'BUY' as const, setup: 'CONTINUATION' as const, reason: 't' };
    expect(structureGate(buy, 'TREND_UP', hi, z, null, 'UP').ok).toBe(false);

    _resetBrainGenomeForTests({ entry_trend_tip_require_reject: false });
    expect(structureGate(buy, 'TREND_UP', hi, z, null, 'UP').ok).toBe(true);
    _setEntryFilterLevelForTests(null);
  });

  it('peak_keep_genome_owns — genome can ease Keep below desk', () => {
    expect(getBrainGenome().peak_keep_genome_owns).toBe(true);
    expect(effectivePeakKeep(0.9, 0.6)).toBe(0.6);

    _resetBrainGenomeForTests({ peak_keep_genome_owns: false });
    expect(effectivePeakKeep(0.9, 0.6)).toBe(0.9);
  });

  it('deep_giveback_offset genome moves Soft+ deep bank line', () => {
    // keep 0.82 − offset 0.12 → line 0.70
    expect(softPlusDeepGiveback(0.69, 0.82, 0.12)).toBe(true);
    expect(softPlusDeepGiveback(0.71, 0.82, 0.12)).toBe(false);
    _resetBrainGenomeForTests({ deep_giveback_offset: 0.05 });
    // keep 0.82 − 0.05 → line 0.77
    expect(softPlusDeepGiveback(0.76, 0.82)).toBe(true);
    expect(softPlusDeepGiveback(0.78, 0.82)).toBe(false);
  });

  it('mind_cut_soft_mult genome moves Soft-loss learner CUT threshold', () => {
    expect(softLossLearnerCutMfe(1.5, 2.0, 0.75)).toBe(true); // 1.5 >= 1.5
    expect(softLossLearnerCutMfe(1.4, 2.0, 0.75)).toBe(false);
    _resetBrainGenomeForTests({ mind_cut_soft_mult: 0.5 });
    expect(softLossLearnerCutMfe(1.0, 2.0)).toBe(true);
    expect(softLossLearnerCutMfe(0.9, 2.0)).toBe(false);
  });
});
