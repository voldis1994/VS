/**
 * Trading-intel genome → regime classify + multi-TF mind consumption.
 * Factory genome must preserve prior hardcoded behaviour.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _resetBrainGenomeForTests,
  getBrainGenome,
  reloadBrainGenome,
  setBrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import { classifyRegime, MIN_BARS_FOR_ZONE, stabilizeRegime } from './regimes.js';
import { readMultiTfStack, sideFromMultiTf, trekBiasFromCandles, capitalTfTrekDir } from './multiTfRead.js';
import { isMoving10s, type TenSecBar } from './tenSecondOhlc.js';
import { thinkEntryLikeTrader } from './traderMind.js';
import { _evalInternals } from '../brainSelfImprove/evaluate.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

function padBars(signal: TenSecBar[]): TenSecBar[] {
  if (signal.length >= MIN_BARS_FOR_ZONE) return signal;
  const sigHi = Math.max(...signal.map((b) => b.high));
  const sigLo = Math.min(...signal.map((b) => b.low));
  const mid = (sigHi + sigLo) / 2;
  const half = Math.max((sigHi - sigLo) / 2, mid * 0.0004);
  const n = MIN_BARS_FOR_ZONE - signal.length;
  const pad: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const wobble = ((i % 4) - 1.5) * half * 0.2;
    const c = mid + wobble;
    pad.push(bar(c, c + half * 0.35, c - half * 0.35, c, i));
  }
  return [
    ...pad,
    ...signal.map((b, i) => ({ ...b, open_time_ms: (n + i) * 10_000 })),
  ];
}

describe('genome trading intelligence — regime + multi-TF', () => {
  const prevGen = process.env.BRAIN_GENOME_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genome-intel-'));
    process.env.BRAIN_GENOME_PATH = path.join(tmp, 'genome.json');
    _resetBrainGenomeForTests();
    setBrainGenome(getBrainGenome());
  });

  afterEach(() => {
    if (prevGen === undefined) delete process.env.BRAIN_GENOME_PATH;
    else process.env.BRAIN_GENOME_PATH = prevGen;
    _resetBrainGenomeForTests();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('factory genome keeps REVERSAL_CANDIDATE on violent opposite bar', () => {
    const bars = padBars([
      bar(100.0, 101.0, 99.6, 100.7, 0),
      bar(100.7, 101.2, 100.3, 101.0, 1),
      bar(101.0, 101.3, 100.4, 100.9, 2),
      bar(100.9, 101.0, 99.65, 99.7, 3),
    ]);
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
  });

  it('raising regime_reversal removes REVERSAL classify for same bars', () => {
    // Wide early zone + enough tight mom bars so avgRange stays low; flip body ~0.20%
    const quiet: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE - 10; i++) {
      quiet.push(bar(100, 101.2, 98.8, 100, i));
    }
    for (let i = 0; i < 9; i++) {
      const c = 100.4 + i * 0.01;
      quiet.push(bar(c, c + 0.015, c - 0.015, c + 0.008, quiet.length));
    }
    const flipOpen = 100.5;
    const flipClose = flipOpen * (1 - 0.002); // −0.20%
    const flip = bar(flipOpen, flipOpen + 0.02, flipClose - 0.2, flipClose, quiet.length);
    const bars = [...quiet, flip];
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
    setBrainGenome({ regime_reversal: 0.0035 });
    expect(getBrainGenome().regime_reversal).toBeCloseTo(35, 5);
    expect(classifyRegime(bars, 'TREND_UP')).not.toBe('REVERSAL_CANDIDATE');
  });

  it('REJECT-style reload restores factory regime_reversal for next classify', () => {
    const quiet: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE - 10; i++) {
      quiet.push(bar(100, 101.2, 98.8, 100, i));
    }
    for (let i = 0; i < 9; i++) {
      const c = 100.4 + i * 0.01;
      quiet.push(bar(c, c + 0.015, c - 0.015, c + 0.008, quiet.length));
    }
    const flipOpen = 100.5;
    const flipClose = flipOpen * (1 - 0.002);
    const flip = bar(flipOpen, flipOpen + 0.02, flipClose - 0.2, flipClose, quiet.length);
    const bars = [...quiet, flip];
    setBrainGenome({ regime_reversal: 0.0035 });
    expect(classifyRegime(bars, 'TREND_UP')).not.toBe('REVERSAL_CANDIDATE');
    fs.writeFileSync(
      process.env.BRAIN_GENOME_PATH!,
      JSON.stringify(
        {
          version: 1,
          peak_keep: 0.75,
          regime_reversal: 0.0016,
        },
        null,
        2
      )
    );
    reloadBrainGenome();
    expect(getBrainGenome().regime_reversal).toBeCloseTo(16, 5);
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
  });

  it('ACCEPT persists regime_min_dwell_bars into stabilizeRegime', () => {
    setBrainGenome({ regime_min_dwell_bars: 8, regime_confirm_bars: 4 });
    const book = {
      current: 'TREND_UP' as const,
      previous: 'UNKNOWN' as const,
      bars_in_current: 3,
      pending: null as null | string,
      pending_count: 0,
      since: new Date().toISOString(),
    };
    // Soft switch before dwell — should hold TREND_UP with dwell=8
    const held = stabilizeRegime(book as never, 'RANGE');
    expect(held).toBe('TREND_UP');
    expect(book.pending_count).toBe(1);
  });

  it('mtf_require_aligned_side gates sideFromMultiTf on 1m fight', () => {
    _resetBrainGenomeForTests({
      mtf_require_aligned_side: true,
      wait_on_1m_fight: true,
    });
    const fighting = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'UP',
    });
    expect(fighting.aligned).toBe(false);
    expect(sideFromMultiTf(fighting)).toBe('WAIT');

    _resetBrainGenomeForTests({
      mtf_require_aligned_side: false,
      wait_on_1m_fight: true,
    });
    const open = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'UP',
    });
    expect(getBrainGenome().mtf_require_aligned_side).toBe(false);
    expect(sideFromMultiTf(open)).toBe('SELL');
  });

  it('mtf_htf_veto true blocks knife SELL vs UP 30/15; false does not force WAIT for that reason', () => {
    _resetBrainGenomeForTests({
      mtf_htf_veto: true,
      require_1m_trigger: false,
      wait_on_1m_fight: false,
      mtf_require_aligned_side: false,
      mtf_block_higher_fight: false,
      entry_story_conf_min: 0.4,
    });
    // Flat stack + regime short → SELL (no HTF UP)
    const okSell = thinkEntryLikeTrader({
      regime: 'TREND_DOWN',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.85,
      red_1m: 16,
      green_1m: 4,
      zone_pos: 0.55,
      bar_body_sign: -1,
      m1_dir: 'DOWN',
      bias: 'DOWN',
      tf5_dir: 'FLAT',
      tf15_dir: 'FLAT',
      tf30_dir: 'FLAT',
    });
    expect(okSell.choice).toBe('SELL');

    // Same short pressure but 30/15 UP — HTF veto must not allow SELL
    const vetoed = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.85,
      red_1m: 16,
      green_1m: 4,
      zone_pos: 0.55,
      bar_body_sign: -1,
      m1_dir: 'FLAT',
      bias: 'UP',
      tf5_dir: 'FLAT',
      tf15_dir: 'UP',
      tf30_dir: 'UP',
    });
    expect(vetoed.choice).not.toBe('SELL');
    expect(getBrainGenome().mtf_htf_veto).toBe(true);
  });

  it('mtf_block_higher_fight false keeps working bias on 30/15 fight', () => {
    _resetBrainGenomeForTests({ mtf_block_higher_fight: true });
    const blocked = readMultiTfStack({
      tf30: 'UP',
      tf15: 'DOWN',
      tf5: 'FLAT',
      tf1: 'FLAT',
    });
    expect(blocked.bias).toBe('FLAT');
    expect(sideFromMultiTf(blocked)).toBe('WAIT');

    _resetBrainGenomeForTests({
      mtf_block_higher_fight: false,
      mtf_require_aligned_side: false,
      wait_on_1m_fight: false,
    });
    const open = readMultiTfStack({
      tf30: 'UP',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'DOWN',
    });
    expect(open.higher_fight).toBe(true);
    expect(open.bias).toBe('DOWN');
    expect(sideFromMultiTf(open)).toBe('SELL');
  });

  it('factory genome: single closed Capital candle trek equals tip color (1:1)', () => {
    // closed + forming tip — same contract as capitalCandleDir / lastClosed
    const candles = [
      { open: 2650.0, high: 2650.8, low: 2649.9, close: 2650.6 }, // closed UP
      { open: 2650.6, high: 2650.7, low: 2650.4, close: 2650.5 }, // forming
    ];
    _resetBrainGenomeForTests();
    expect(getBrainGenome().mtf_trek_flat_frac).toBeCloseTo(4, 5);
    expect(capitalTfTrekDir(candles, 4)).toBe('UP');
    expect(trekBiasFromCandles(candles, 4)).toBe('UP');
  });

  it('mtf_trek_flat_frac change alters trekBias flatness', () => {
    const candles = [
      { open: 2650.0, high: 2650.6, low: 2649.8, close: 2650.4 },
      { open: 2650.4, high: 2651.0, low: 2650.2, close: 2650.8 },
      { open: 2650.8, high: 2651.4, low: 2650.5, close: 2651.1 },
      { open: 2651.1, high: 2651.6, low: 2650.9, close: 2651.4 },
      { open: 2651.4, high: 2651.8, low: 2651.2, close: 2651.5 },
    ];
    _resetBrainGenomeForTests({ mtf_trek_flat_frac: 0.0004 });
    const factory = trekBiasFromCandles(candles, 4);
    expect(factory).toBe('UP');

    _resetBrainGenomeForTests({ mtf_trek_flat_frac: 0.001 });
    const loose = trekBiasFromCandles(candles, 4);
    expect(loose).toBe('FLAT');
  });

  it('mtf_trek_flat_frac live path: Capital TF trek → mind stack → entry decision → evaluator', () => {
    const candles = [
      { open: 2650.0, high: 2650.6, low: 2649.8, close: 2650.4 },
      { open: 2650.4, high: 2651.0, low: 2650.2, close: 2650.8 },
      { open: 2650.8, high: 2651.4, low: 2650.5, close: 2651.1 },
      { open: 2651.1, high: 2651.6, low: 2650.9, close: 2651.4 },
      { open: 2651.4, high: 2651.8, low: 2651.2, close: 2651.5 },
    ];

    _resetBrainGenomeForTests({
      mtf_trek_flat_frac: 0.0004,
      mtf_block_higher_fight: true,
      mtf_require_aligned_side: false,
      wait_on_1m_fight: false,
      mtf_htf_veto: false,
    });
    const tf30 = capitalTfTrekDir(candles, 4);
    expect(tf30).toBe('UP');
    const stack = readMultiTfStack({
      tf30,
      tf15: 'UP',
      tf5: 'UP',
      tf1: 'UP',
    });
    expect(sideFromMultiTf(stack)).toBe('BUY');
    const buyMind = thinkEntryLikeTrader({
      regime: 'TREND_UP',
      chapter: 'RALLY',
      allow: 'BUY',
      story_conf: 0.8,
      red_1m: 4,
      green_1m: 16,
      zone_pos: 0.4,
      bar_body_sign: 1,
      m1_dir: 'UP',
      bias: stack.bias,
      tf5_dir: 'UP',
      tf15_dir: 'UP',
      tf30_dir: tf30,
    });
    expect(buyMind.choice).toBe('BUY');

    setBrainGenome({ mtf_trek_flat_frac: 0.001 });
    reloadBrainGenome();
    const tf30Loose = capitalTfTrekDir(candles, 4);
    expect(tf30Loose).toBe('FLAT');
    const flatStack = readMultiTfStack({
      tf30: tf30Loose,
      tf15: 'FLAT',
      tf5: 'FLAT',
      tf1: 'FLAT',
    });
    expect(sideFromMultiTf(flatStack)).toBe('WAIT');

    _resetBrainGenomeForTests({ mtf_trek_flat_frac: 0.0004 });
    const factoryProbes = _evalInternals.scoreMtfIntelProbes();
    expect(factoryProbes.mtf_trek_flat_frac.hit).toBe(1);

    setBrainGenome({ mtf_trek_flat_frac: 0.001 });
    reloadBrainGenome();
    const looseProbes = _evalInternals.scoreMtfIntelProbes();
    expect(looseProbes.mtf_trek_flat_frac.hit).toBe(0);
  });

  it('each MTF / entry intel probe moves only when that key is hostile', () => {
    _resetBrainGenomeForTests();
    const factory = _evalInternals.scoreMtfIntelProbes();
    for (const k of [
      'mtf_trek_flat_frac',
      'mtf_block_higher_fight',
      'mtf_require_aligned_side',
      'entry_story_conf_min',
    ] as const) {
      expect(factory[k]?.hit, `${k} factory hit`).toBe(1);
    }

    const hostiles: Array<{ key: string; patch: Record<string, unknown> }> = [
      { key: 'mtf_trek_flat_frac', patch: { mtf_trek_flat_frac: 0.001 } },
      { key: 'mtf_block_higher_fight', patch: { mtf_block_higher_fight: false } },
      { key: 'mtf_require_aligned_side', patch: { mtf_require_aligned_side: false } },
      { key: 'entry_story_conf_min', patch: { entry_story_conf_min: 0.4 } },
    ];

    for (const h of hostiles) {
      _resetBrainGenomeForTests(h.patch);
      const scored = _evalInternals.scoreMtfIntelProbes();
      expect(scored[h.key]?.hit, `${h.key} hostile must miss`).toBe(0);
      for (const other of hostiles) {
        if (other.key === h.key) continue;
        expect(scored[other.key]?.hit, `${h.key} hostile must not break ${other.key}`).toBe(1);
      }
    }
  });

  it('robotDesk live Capital higher TF path consumes capitalTfTrekDir (not tip capitalCandleDir)', () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'robotDesk.ts'
      ),
      'utf8'
    );
    expect(src).toMatch(/capitalHigherTfDir\(s\.last_tf5_candles\)/);
    expect(src).toMatch(/capitalHigherTfDir\(s\.last_tf15_candles\)/);
    expect(src).toMatch(/capitalHigherTfDir\(s\.last_tf30_candles\)/);
    expect(src).toMatch(/capitalTfTrekDir/);
    expect(src).not.toMatch(/capital_tf5_dir:\s*capitalCandleDir/);
    expect(src).not.toMatch(/capital_tf15_dir:\s*capitalCandleDir/);
    expect(src).not.toMatch(/capital_tf30_dir:\s*capitalCandleDir/);
    // 1m trigger stays tip-candle (not trek)
    expect(src).toMatch(/capital_m1_dir:\s*capitalCandleDir/);
  });

  it('raising regime_move changes FAILED_BREAKOUT_UP classify', () => {
    // In-range tip with body ~0.012%: below raised MOVE (0.02%), above factory (0.008%).
    const bars: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      bars.push(bar(100, 100.4, 99.6, 100, i));
    }
    const o = 100.05;
    const c = o - 0.012; // bodyPct ≈ 0.00012 — still inside [99.6, 100.4]
    bars.push(bar(o, o + 0.005, c - 0.005, c, bars.length));

    _resetBrainGenomeForTests({ regime_move: 0.00008 });
    expect(classifyRegime(bars, 'BREAKOUT_UP')).toBe('FAILED_BREAKOUT_UP');

    setBrainGenome({ regime_move: 0.0002 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_move).toBeCloseTo(2, 5);
    expect(classifyRegime(bars, 'BREAKOUT_UP')).not.toBe('FAILED_BREAKOUT_UP');
  });

  it('regime_mom_bars change alters classify on diluted momentum fixture', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      // Mild up noise that pollutes a long mom window
      const wobble = ((i % 5) - 2) * 0.02;
      const c = 100 + wobble;
      bars.push(bar(c, c + 0.03, c - 0.03, c + 0.01, i));
    }
    // Last 5 bars: strong down (~0.12% bodies)
    for (let i = 0; i < 5; i++) {
      const o = 100.2 - i * 0.05;
      const c = o - 0.13;
      bars.push(bar(o, o + 0.01, c - 0.02, c, bars.length));
    }

    _resetBrainGenomeForTests({
      regime_mom_bars: 5,
      regime_persist_window: 5,
      regime_persist_enter: 0.4,
      regime_trend_enter: 0.0003,
      regime_move: 0.00008,
    });
    const short = classifyRegime(bars, 'UNKNOWN');
    expect(short).toBe('TREND_DOWN');

    setBrainGenome({ regime_mom_bars: 16, regime_persist_window: 5 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_mom_bars).toBe(16);
    const long = classifyRegime(bars, 'UNKNOWN');
    // Long mom dilutes the 5 red bars with earlier quiet/up noise
    expect(long).not.toBe('TREND_DOWN');
  });

  it('regime_clear_break_frac change gates BREAKOUT_UP', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      bars.push(bar(100, 100.3, 99.7, 100, i));
    }
    // Pierce only ~15% of zone width above hi — below factory CLEAR_BREAK 0.25
    const hi = 100.3;
    const zoneWidth = 0.6;
    const pierce = hi + zoneWidth * 0.15;
    bars.push(bar(100.1, pierce + 0.05, 100.0, pierce, bars.length));

    _resetBrainGenomeForTests({
      regime_clear_break_frac: 0.25,
      regime_trend_enter: 0.0002,
      regime_expand_abs: 0.0003,
      regime_expand_avg_mult: 1.2,
    });
    const tight = classifyRegime(bars, 'RANGE');
    expect(tight).not.toBe('BREAKOUT_UP');

    setBrainGenome({ regime_clear_break_frac: 0.1 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_clear_break_frac).toBeCloseTo(0.1, 5);
    const loose = classifyRegime(bars, 'RANGE');
    expect(loose).toBe('BREAKOUT_UP');
  });

  it('regime_move_range change gates isMoving10s on range-only bars', () => {
    // Range ~0.015% — above factory MOVE_RANGE 0.012%, below raised 0.0002 (≤ TREND_STAY)
    const mid = 100;
    const quietish = bar(mid, mid + mid * 0.00015, mid - mid * 0.00001, mid + mid * 0.00002);
    _resetBrainGenomeForTests({
      regime_move_range: 0.00012,
      regime_move: 0.00008,
      regime_trend_stay: 0.00022,
    });
    expect(isMoving10s(quietish)).toBe(true);

    setBrainGenome({ regime_move_range: 0.0002, regime_trend_stay: 0.00022 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_move_range).toBeCloseTo(2, 5);
    expect(isMoving10s(quietish)).toBe(false);
  });

  it('regime_compress_abs + near_zone_mid gate COMPRESSION', () => {
    const bars: TenSecBar[] = [];
    // Wide zone early, then quiet mom bars so avgRange is tiny
    for (let i = 0; i < MIN_BARS_FOR_ZONE - 12; i++) {
      bars.push(bar(100, 100.6, 99.4, 100, i));
    }
    for (let i = 0; i < 12; i++) {
      bars.push(bar(100.0, 100.003, 99.997, 100.0, bars.length));
    }
    bars.push(bar(100.0, 100.002, 99.998, 100.0, bars.length));

    _resetBrainGenomeForTests({
      regime_compress_abs: 0.00008,
      regime_compress_avg_mult: 0.9,
      regime_near_zone_mid: 0.35,
      regime_mom_bars: 8,
      regime_move: 0.00008,
    });
    expect(classifyRegime(bars, 'RANGE')).toBe('COMPRESSION');

    // Tip far from zone mid — near_zone_mid gate must drop COMPRESSION
    const offMid = [
      ...bars.slice(0, -1),
      bar(100.4, 100.403, 100.397, 100.4, bars.length - 1),
    ];
    expect(classifyRegime(offMid, 'RANGE')).not.toBe('COMPRESSION');
  });

  it('regime_persist_stay change keeps vs drops in-family TREND_DOWN', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      bars.push(bar(100, 100.8, 99.2, 100, i));
    }
    // 4 down + 2 up ⇒ persistence ≈ -0.33; last bar must still be a down body
    const seq = [-1, -1, -1, -1, 1, -1];
    let px = 100;
    for (const s of seq) {
      const o = px;
      const c = o + s * 0.04; // bodyPct ≈ 0.0004
      bars.push(bar(o, Math.max(o, c) + 0.01, Math.min(o, c) - 0.01, c, bars.length));
      px = c;
    }

    _resetBrainGenomeForTests({
      regime_mom_bars: 6,
      regime_persist_window: 6,
      regime_persist_enter: 0.85,
      regime_persist_stay: 0.25,
      regime_trend_stay: 0.0002,
      regime_move: 0.00008,
    });
    expect(classifyRegime(bars, 'TREND_DOWN')).toBe('TREND_DOWN');

    setBrainGenome({ regime_persist_stay: 0.7, regime_persist_enter: 0.85 });
    reloadBrainGenome();
    expect(getBrainGenome().regime_persist_stay).toBeCloseTo(0.7, 5);
    // In-family stay fails; tip still in wide zone — sticky prior TREND, NOT invent RANGE
    expect(classifyRegime(bars, 'TREND_DOWN')).toBe('TREND_DOWN');
  });
});
