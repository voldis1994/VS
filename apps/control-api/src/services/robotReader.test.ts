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

describe('per-client OHLC mid (OWN Capital only)', () => {
  it('always prefers LOCAL mid for OHLC — peers never rewrite', () => {
    const p = pickOhlcMid(2000, {
      mid: 2000.4,
      contributing: 3,
      agreement: 'STRONG',
      anchored_to_capital: true,
    });
    expect(p.source).toBe('LOCAL');
    expect(p.mid).toBe(2000);
  });

  it('keeps LOCAL when multi mid is far', () => {
    const p = pickOhlcMid(2338, {
      mid: 4420,
      contributing: 2,
      agreement: 'OK',
      anchored_to_capital: false,
    });
    expect(p.source).toBe('LOCAL');
    expect(p.mid).toBe(2338);
  });

  it('uses MULTI only when local mid missing', () => {
    const p = pickOhlcMid(null, { mid: 100.2, contributing: 1, agreement: 'INSUFFICIENT', anchored_to_capital: true });
    expect(p).toEqual({ mid: 100.2, source: 'MULTI' });
  });

  it('returns NONE when nothing usable', () => {
    expect(pickOhlcMid(null, null).source).toBe('NONE');
    expect(pickOhlcMid(undefined, { mid: null, contributing: 0, agreement: 'NONE' }).source).toBe(
      'NONE'
    );
  });
});

describe('own Capital feed gate', () => {
  it('owns OHLC when own Capital is live', () => {
    expect(
      multiFeedOwnsOhlc({
        contributing: 1,
        agreement: 'INSUFFICIENT',
        capital_contributing: 1,
        anchored_to_capital: true,
      })
    ).toBe(true);
  });

  it('allows trade on single OWN Capital LEAD', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 1,
        sender_count: 1,
        agreement: 'INSUFFICIENT',
        capital_contributing: 1,
        capital_sender_count: 1,
      }).ok
    ).toBe(true);
  });

  it('blocks only when zero Capital quotes', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 0,
        sender_count: 1,
        agreement: 'NONE',
        capital_contributing: 0,
        capital_sender_count: 1,
      }).ok
    ).toBe(false);
  });

  it('does not block on peer DIVERGENT (peers isolated)', () => {
    expect(
      allowEntryFromFeeds({
        contributing: 1,
        sender_count: 1,
        agreement: 'DIVERGENT',
        capital_contributing: 1,
        capital_sender_count: 1,
      }).ok
    ).toBe(true);
  });
});
