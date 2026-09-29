import { describe, expect, it, beforeEach } from 'vitest';
import {
  dirFromCandles,
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

  it('5m fighting higher bias → WAIT (no knife)', () => {
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

  it('fresh closed red beats stale green majority (Gold dump vs 5m↑ bug)', () => {
    // 3×5m rally greens then 1×5m dump red — Capital chart is DOWN; old trek stayed UP
    const candles = [
      { open: 4164, high: 4168, low: 4163, close: 4167 },
      { open: 4167, high: 4170, low: 4166, close: 4169 },
      { open: 4169, high: 4173, low: 4168, close: 4172 },
      { open: 4172, high: 4172.5, low: 4164, close: 4165 }, // closed dump
      { open: 4165, high: 4166, low: 4163, close: 4163.5 }, // forming
    ];
    expect(trekBiasFromCandles(candles, 4)).toBe('DOWN');
    expect(trekBiasFromCandles(candles, 4)).not.toBe('UP');
  });

  it('fresh closed green beats stale red majority', () => {
    const candles = [
      { open: 4172, high: 4173, low: 4168, close: 4169 },
      { open: 4169, high: 4170, low: 4165, close: 4166 },
      { open: 4166, high: 4167, low: 4163, close: 4164 },
      { open: 4164, high: 4171, low: 4163.5, close: 4170 }, // closed recovery
      { open: 4170, high: 4171, low: 4169, close: 4170.2 },
    ];
    expect(trekBiasFromCandles(candles, 4)).toBe('UP');
  });
});
