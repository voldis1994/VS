import { describe, expect, it } from 'vitest';
import {
  allowEntryFromFeeds,
  isPublicNearCapital,
  multiFeedOwnsOhlc,
  pickOhlcMid,
} from './robotReader.js';

describe('Capital anchor band (no false LEAD)', () => {
  it('rejects Yahoo ~4724 vs Capital GOLD ~4663 (~1.3%)', () => {
    expect(isPublicNearCapital(4724.3, 4663.27, 'GOLD')).toBe(false);
    expect(isPublicNearCapital(4723.9, 4663.27, 'GOLD')).toBe(false);
  });

  it('accepts public within ~0.25% of Capital GOLD', () => {
    expect(isPublicNearCapital(4665, 4663.27, 'GOLD')).toBe(true);
    expect(isPublicNearCapital(4675, 4663.27, 'GOLD')).toBe(false);
  });
});

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

  it('hard-blocks when Capital peers are DIVERGENT', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 2,
        sender_count: 2,
        agreement: 'DIVERGENT',
        capital_contributing: 2,
        capital_sender_count: 2,
      }).ok
    ).toBe(false);
  });

  it('allows trade when public would be REJECT — only Capital matters', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 3,
        sender_count: 3,
        agreement: 'STRONG',
        capital_contributing: 3,
        capital_sender_count: 3,
      }).ok
    ).toBe(true);
  });

  it('blocks only when zero Capital quotes', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 0,
        sender_count: 3,
        agreement: 'NONE',
        capital_contributing: 0,
        capital_sender_count: 3,
      }).ok
    ).toBe(false);
  });

  it('blocks when no Capital quote at all', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 0,
        sender_count: 4,
        agreement: 'INSUFFICIENT',
        capital_contributing: 0,
        capital_sender_count: 3,
      }).ok
    ).toBe(false);
  });
});
