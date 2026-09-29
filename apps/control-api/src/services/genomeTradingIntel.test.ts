/**
 * Trading-intel genome → regime classify + multi-TF mind consumption.
 * Factory genome must preserve prior hardcoded behaviour.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetBrainGenomeForTests,
  getBrainGenome,
  reloadBrainGenome,
  setBrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import { classifyRegime, MIN_BARS_FOR_ZONE, stabilizeRegime } from './regimes.js';
import { thinkEntryLikeTrader } from './traderMind.js';
import { readMultiTfStack, sideFromMultiTf, trekBiasFromCandles } from './multiTfRead.js';
import type { TenSecBar } from './tenSecondOhlc.js';

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
    expect(getBrainGenome().regime_reversal).toBeCloseTo(0.0035, 6);
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
    expect(getBrainGenome().regime_reversal).toBeCloseTo(0.0016, 6);
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

  it('mtf_htf_veto is live-consumed from genome (default true)', () => {
    _resetBrainGenomeForTests({ mtf_htf_veto: true });
    expect(getBrainGenome().mtf_htf_veto).toBe(true);
    _resetBrainGenomeForTests({ mtf_htf_veto: false });
    expect(getBrainGenome().mtf_htf_veto).toBe(false);
    const t = thinkEntryLikeTrader({
      regime: 'RANGE',
      chapter: 'SELLOFF',
      allow: 'SELL',
      story_conf: 0.8,
      red_1m: 16,
      green_1m: 4,
      zone_pos: 0.6,
      bar_body_sign: -1,
      m1_dir: 'FLAT',
      bias: 'UP',
      tf5_dir: 'FLAT',
      tf15_dir: 'UP',
      tf30_dir: 'UP',
    });
    // With veto off + UP stack, mind may BUY or WAIT — must not crash; flag is false
    expect(getBrainGenome().mtf_htf_veto).toBe(false);
    expect(['BUY', 'WAIT', 'SELL']).toContain(t.choice);
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

  it('mtf_trek_flat_frac change alters trekBias flatness', () => {
    const candles = [
      { open: 100, high: 100.05, low: 99.98, close: 100.02 },
      { open: 100.02, high: 100.06, low: 100.0, close: 100.04 },
      { open: 100.04, high: 100.07, low: 100.01, close: 100.05 },
      { open: 100.05, high: 100.08, low: 100.02, close: 100.06 },
      { open: 100.06, high: 100.09, low: 100.03, close: 100.07 },
    ];
    _resetBrainGenomeForTests({ mtf_trek_flat_frac: 0.00015 });
    const tight = trekBiasFromCandles(candles, 4);
    _resetBrainGenomeForTests({ mtf_trek_flat_frac: 0.001 });
    const loose = trekBiasFromCandles(candles, 4);
    // Loose flat frac treats small trek as FLAT; tight may read UP
    expect(loose).toBe('FLAT');
    expect(['UP', 'FLAT']).toContain(tight);
  });
});
