import { describe, expect, it } from 'vitest';
import { pickOhlcMid } from './robotReader.js';

describe('multi-feed OHLC mid pick', () => {
  it('prefers MULTI when ≥2 feeds agree', () => {
    const p = pickOhlcMid(2000, {
      mid: 2000.4,
      contributing: 3,
      agreement: 'STRONG',
    });
    expect(p.source).toBe('MULTI');
    expect(p.mid).toBe(2000.4);
  });

  it('falls back to LOCAL when only one feed or divergent', () => {
    expect(
      pickOhlcMid(1999.5, { mid: 2005, contributing: 1, agreement: 'INSUFFICIENT' }).source
    ).toBe('LOCAL');
    expect(
      pickOhlcMid(1999.5, { mid: 2012, contributing: 2, agreement: 'DIVERGENT' }).source
    ).toBe('LOCAL');
  });

  it('uses MULTI alone when local mid missing', () => {
    const p = pickOhlcMid(null, { mid: 100.2, contributing: 2, agreement: 'OK' });
    expect(p).toEqual({ mid: 100.2, source: 'MULTI' });
  });

  it('returns NONE when nothing usable', () => {
    expect(pickOhlcMid(null, null).source).toBe('NONE');
    expect(pickOhlcMid(undefined, { mid: null, contributing: 0, agreement: 'NONE' }).source).toBe(
      'NONE'
    );
  });
});
