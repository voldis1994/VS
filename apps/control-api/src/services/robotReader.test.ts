import { describe, expect, it } from 'vitest';
import {
  allowEntryFromFeeds,
  capitalOhlcMid,
  multiFeedOwnsOhlc,
  pickOhlcMid,
} from './robotReader.js';

describe('multi-feed OHLC mid pick (Capital-anchored)', () => {
  it('uses MULTI blend when multi mid is near Capital local', () => {
    const p = pickOhlcMid(2000, {
      mid: 2000.4,
      contributing: 3,
      agreement: 'STRONG',
      anchored_to_capital: true,
    });
    expect(p.source).toBe('MULTI');
    expect(p.mid).toBeCloseTo(2000 * 0.65 + 2000.4 * 0.35, 5);
  });

  it('keeps LOCAL when public/multi mid is far from Capital', () => {
    const p = pickOhlcMid(2338, {
      mid: 4420,
      contributing: 2,
      agreement: 'OK',
      anchored_to_capital: false,
    });
    expect(p.source).toBe('LOCAL');
    expect(p.mid).toBe(2338);
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

  it('capitalOhlcMid always prefers Capital local when present', () => {
    const p = capitalOhlcMid(4587.87, {
      mid: 4640.6,
      contributing: 4,
      agreement: 'OK',
      anchored_to_capital: true,
    });
    expect(p).toEqual({ mid: 4587.87, source: 'LOCAL' });
  });
});

describe('multi-feed owns OHLC / entry gate', () => {
  it('owns OHLC only when Capital is in the cluster', () => {
    expect(
      multiFeedOwnsOhlc({
        contributing: 2,
        agreement: 'OK',
        capital_contributing: 1,
        anchored_to_capital: true,
      })
    ).toBe(true);
    expect(
      multiFeedOwnsOhlc({
        contributing: 2,
        agreement: 'OK',
        capital_contributing: 0,
        anchored_to_capital: false,
      })
    ).toBe(false);
  });

  it('never freezes entry due to public-only sender_count', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 0,
        sender_count: 4,
        agreement: 'INSUFFICIENT',
        capital_contributing: 1,
        capital_sender_count: 1,
      }).ok
    ).toBe(true);
    expect(
      allowEntryFromFeeds({
        contributing: 2,
        sender_count: 2,
        agreement: 'DIVERGENT',
        capital_contributing: 0,
        capital_sender_count: 0,
      }).ok
    ).toBe(true);
  });
});
