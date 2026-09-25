import { describe, expect, it } from 'vitest';
import {
  dirFromCandles,
  readMultiTfStack,
  sideFromMultiTf,
  trekBiasFromCandles,
} from './multiTfRead.js';

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

  it('1m pullback against aligned 5m still holds side', () => {
    const stack = readMultiTfStack({
      tf30: 'UP',
      tf15: 'UP',
      tf5: 'UP',
      tf1: 'DOWN',
    });
    expect(stack.bias).toBe('UP');
    // mid not fighting — sideFrom may still BUY (wait for trigger) or WAIT
    const side = sideFromMultiTf(stack);
    expect(side).not.toBe('SELL');
    expect(['BUY', 'WAIT']).toContain(side);
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
});
