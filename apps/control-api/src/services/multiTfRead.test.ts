import { describe, expect, it, beforeEach } from 'vitest';
import {
  dirFromCandles,
  formingTipDir,
  htfBiasFromDirs,
  liveChartCandleDir,
  m1DirForEntry,
  readMultiTfStack,
  sideFromMultiTf,
  trekBiasFromCandles,
} from './multiTfRead.js';
import { _resetBrainGenomeForTests } from '../brainSelfImprove/brainGenome.js';

beforeEach(() => {
  _resetBrainGenomeForTests();
});

describe('multiTfRead', () => {
  it('reads last closed candle direction (drops forming tip)', () => {
    expect(
      dirFromCandles([
        { open: 100, high: 101, low: 99, close: 100.5 },
        { open: 100.5, high: 102, low: 100, close: 101 }, // forming
      ])
    ).toBe('UP');
    expect(
      dirFromCandles([
        { open: 100, high: 101, low: 98, close: 99 },
        { open: 99, high: 99.5, low: 98.5, close: 99.2 },
      ])
    ).toBe('DOWN');
  });

  it('aligned UP stack → BUY', () => {
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'UP',
      tf5: 'UP',
      tf1: 'UP',
    });
    expect(stack.bias).toBe('UP');
    expect(stack.aligned).toBe(true);
    expect(stack.summary).toBe('30m↑ 15m↑ 5m↑ 1m↑');
    expect(sideFromMultiTf(stack)).toBe('BUY');
  });

  it('aligned DOWN stack → SELL', () => {
    const stack = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'DOWN',
    });
    expect(stack.bias).toBe('DOWN');
    expect(sideFromMultiTf(stack)).toBe('SELL');
  });

  it('30m vs 15m fight → WAIT', () => {
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'DOWN',
      tf5: 'UP',
      tf1: 'UP',
    });
    expect(stack.aligned).toBe(false);
    expect(sideFromMultiTf(stack)).toBe('WAIT');
    expect(stack.thesis_lv).toMatch(/nesakrīt|gaidu/i);
  });

  it('5m fighting + 1m also against → WAIT (no knife)', () => {
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'UP',
      tf5: 'DOWN',
      tf1: 'DOWN',
    });
    expect(stack.bias).toBe('UP');
    expect(stack.aligned).toBe(false);
    expect(sideFromMultiTf(stack)).toBe('WAIT');
  });

  it('5m bounce against bias but 1m already with bias → SELL pullback (not sit dump)', () => {
    // Gold dump: 30/15 DOWN, one 5m green bounce, 1m already red → sell the bounce
    const stack = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'UP',
      tf1: 'DOWN',
    });
    expect(stack.bias).toBe('DOWN');
    expect(stack.aligned).toBe(true);
    expect(sideFromMultiTf(stack)).toBe('SELL');
    expect(stack.thesis_lv).toMatch(/SELL pullback|bounce/i);
  });

  it('5m bounce + 1m not ready → still WAIT', () => {
    const stack = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'UP',
      tf1: 'FLAT',
    });
    expect(stack.bias).toBe('DOWN');
    expect(sideFromMultiTf(stack)).toBe('WAIT');
  });

  it('1m pullback against higher bias → WAIT (no PRĀTS knife into Soft)', () => {
    const stack = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: 'UP',
    });
    expect(stack.bias).toBe('DOWN');
    expect(stack.aligned).toBe(false);
    // Bias still DOWN for thesis — but side WAIT until 1m red (was SELL→Soft spam)
    expect(sideFromMultiTf(stack)).toBe('WAIT');
  });

  it('1m pullback against aligned 5m still holds bias, not opposite', () => {
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'UP',
      tf5: 'UP',
      tf1: 'DOWN',
    });
    expect(stack.bias).toBe('UP');
    expect(sideFromMultiTf(stack)).toBe('WAIT');
    expect(sideFromMultiTf(stack)).not.toBe('SELL');
  });

  it('only 1m available → follow the tape', () => {
    const stack = readMultiTfStack({
      tf30: 'FLAT',
      tf15: 'FLAT',
      tf5: 'FLAT',
      tf1: 'UP',
    });
    expect(stack.bias).toBe('UP');
    expect(stack.aligned).toBe(true);
    expect(sideFromMultiTf(stack)).toBe('BUY');
  });

  it('trekBiasFromCandles uses color majority', () => {
    const candles = [
      { open: 100, high: 101, low: 99, close: 99.5 },
      { open: 99.5, high: 100, low: 98, close: 98.5 },
      { open: 98.5, high: 99, low: 97, close: 97.5 },
      { open: 97.5, high: 98.5, low: 97, close: 98 }, // forming tip dropped
    ];
    expect(trekBiasFromCandles(candles, 4)).toBe('DOWN');
  });

  it('trekBiasFromCandles dump stays DOWN despite last green bounce', () => {
    // Closed dump + last closed tiny green bounce (forming tip separate)
    const candles = [
      { open: 4190, high: 4192, low: 4180, close: 4181 },
      { open: 4181, high: 4182, low: 4165, close: 4166 },
      { open: 4166, high: 4168, low: 4150, close: 4152 },
      { open: 4152, high: 4155, low: 4151, close: 4154 }, // last closed bounce UP
      { open: 4154, high: 4155, low: 4151, close: 4152 }, // forming
    ];
    expect(dirFromCandles(candles)).toBe('UP'); // lone last closed
    expect(trekBiasFromCandles(candles, 4)).toBe('DOWN'); // trek reads the dump
  });

  it('liveChartCandleDir matches Capital blue tip — not trek dump lag', () => {
    // Live bug: Capital 15m forming green, trek of prior dump said DOWN
    const candles = [
      { open: 4140, high: 4142, low: 4125, close: 4128 }, // red
      { open: 4128, high: 4130, low: 4120, close: 4122 }, // red
      { open: 4122, high: 4168, low: 4121, close: 4165 }, // live blue tip
    ];
    expect(trekBiasFromCandles(candles, 3)).toBe('DOWN');
    expect(liveChartCandleDir(candles)).toBe('UP');
  });

  it('m1DirForEntry uses live tip only when closed 1m is with HTF or flat', () => {
    const candles = [
      { open: 100, high: 101, low: 99, close: 100.5 }, // closed UP
      { open: 100.5, high: 102, low: 100.4, close: 101.8 }, // forming UP tip
    ];
    expect(m1DirForEntry(candles, 'UP')).toBe('UP');
    expect(htfBiasFromDirs('UP', 'UP', 'FLAT')).toBe('UP');
  });

  it('m1DirForEntry tip against HTF stays tip so stack WAIT (Soft shield)', () => {
    const candles = [
      { open: 100, high: 101, low: 99, close: 100.5 }, // closed UP
      { open: 100.5, high: 100.6, low: 99, close: 99.2 }, // forming DOWN tip
    ];
    expect(m1DirForEntry(candles, 'UP')).toBe('DOWN');
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'UP',
      tf5: 'UP',
      tf1: m1DirForEntry(candles, 'UP'),
    });
    expect(sideFromMultiTf(stack)).toBe('WAIT');
  });

  it('m1DirForEntry does not tip-chase when closed 1m already turned against HTF', () => {
    // Stale HTF DOWN + market already UP on closed 1m + tip DOWN flicker = Soft chase
    const candles = [
      { open: 100, high: 102, low: 99, close: 101.5 }, // closed UP — turn
      { open: 101.5, high: 101.6, low: 100.8, close: 101.0 }, // tip DOWN flicker
    ];
    expect(dirFromCandles(candles)).toBe('UP');
    expect(formingTipDir(candles)).toBe('DOWN');
    expect(m1DirForEntry(candles, 'DOWN')).toBe('UP');
    const stack = readMultiTfStack({
      tf30: 'DOWN',
      tf15: 'DOWN',
      tf5: 'DOWN',
      tf1: m1DirForEntry(candles, 'DOWN'),
    });
    expect(stack.aligned).toBe(false);
    expect(sideFromMultiTf(stack)).toBe('WAIT');
    expect(sideFromMultiTf(stack)).not.toBe('SELL');
  });
});
