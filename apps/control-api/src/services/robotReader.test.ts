import { describe, expect, it } from 'vitest';
import {
  allowEntryFromFeeds,
  multiFeedOwnsOhlc,
  pickOhlcMid,
} from './robotReader.js';

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

describe('multi-feed owns OHLC / entry gate', () => {
  it('owns OHLC only when ≥2 providers agree', () => {
    expect(multiFeedOwnsOhlc({ contributing: 2, agreement: 'OK' })).toBe(true);
    expect(multiFeedOwnsOhlc({ contributing: 2, agreement: 'STRONG' })).toBe(true);
    expect(multiFeedOwnsOhlc({ contributing: 2, agreement: 'DIVERGENT' })).toBe(false);
    expect(multiFeedOwnsOhlc({ contributing: 1, agreement: 'INSUFFICIENT' })).toBe(false);
    expect(multiFeedOwnsOhlc(null)).toBe(false);
  });

  it('allows entry on single provider (degraded LOCAL)', () => {
    expect(allowEntryFromFeeds({ contributing: 1, sender_count: 1, agreement: 'INSUFFICIENT' }).ok).toBe(
      true
    );
  });

  it('blocks entry when several providers configured but not agreeing', () => {
    expect(
      allowEntryFromFeeds({ contributing: 1, sender_count: 3, agreement: 'INSUFFICIENT' }).ok
    ).toBe(false);
    expect(
      allowEntryFromFeeds({ contributing: 2, sender_count: 2, agreement: 'DIVERGENT' }).ok
    ).toBe(false);
  });

  it('allows entry when multi-provider consensus is OK/STRONG', () => {
    expect(allowEntryFromFeeds({ contributing: 2, sender_count: 2, agreement: 'OK' }).ok).toBe(true);
    expect(allowEntryFromFeeds({ contributing: 3, sender_count: 3, agreement: 'STRONG' }).ok).toBe(
      true
    );
  });
});
