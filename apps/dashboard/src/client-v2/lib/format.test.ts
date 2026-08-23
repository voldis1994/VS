import { describe, expect, it } from 'vitest';
import { fmtLot, fmtPrice, roundLot } from '../lib/format';

describe('client-v2 format', () => {
  it('rounds lot to step', () => {
    expect(roundLot(0.17, 0.01)).toBe(0.17);
    expect(roundLot(0.175, 0.01)).toBe(0.18);
  });

  it('formats lot trim', () => {
    expect(fmtLot(0.1)).toBe('0.1');
    expect(fmtLot(0.17)).toBe('0.17');
  });

  it('formats price', () => {
    expect(fmtPrice(4623.05)).toBe('4623.05');
    expect(fmtPrice(null)).toBe('—');
  });
});
