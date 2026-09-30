import { describe, expect, it, beforeEach } from 'vitest';
import { isStrongEntrySignal } from './strongEntrySignal.js';
import {
  defaultDeskCalibration,
  getDeskCalibration,
  regimeAllowedForEntry,
  regimeEntryPermitted,
  regimeIsSoftOff,
  setDeskCalibration,
  _resetDeskCalibrationCacheForTests,
} from './deskCalibration.js';

describe('isStrongEntrySignal', () => {
  it('allows BREAKOUT with story BREAK + HTF agree', () => {
    expect(
      isStrongEntrySignal({
        direction: 'BUY',
        setup: 'BREAKOUT',
        storyAllow: 'BUY',
        storyChapter: 'BREAK_UP',
        htf: { tf30: 'UP', tf15: 'UP', tf5: 'FLAT' },
      })
    ).toBe(true);
  });

  it('allows PULLBACK when ≥2 HTF aligned', () => {
    expect(
      isStrongEntrySignal({
        direction: 'SELL',
        setup: 'PULLBACK',
        storyAllow: 'SELL',
        storyChapter: 'SELLOFF',
        htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'FLAT' },
      })
    ).toBe(true);
  });

  it('blocks FADE tip-chase without reject + HTF', () => {
    expect(
      isStrongEntrySignal({
        direction: 'BUY',
        setup: 'FADE',
        storyAllow: 'BUY',
        storyChapter: 'RANGE_CHOP',
        htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
      })
    ).toBe(false);
  });

  it('blocks when story fights direction', () => {
    expect(
      isStrongEntrySignal({
        direction: 'BUY',
        setup: 'PULLBACK',
        storyAllow: 'SELL',
        storyChapter: 'SELLOFF',
        htf: { tf30: 'UP', tf15: 'UP', tf5: 'UP' },
      })
    ).toBe(false);
  });
});

describe('Soft OFF vs Hard OFF entry gate', () => {
  beforeEach(() => {
    _resetDeskCalibrationCacheForTests();
    setDeskCalibration(defaultDeskCalibration());
  });

  it('Hard OFF blocks all — Soft OFF + strong allows', () => {
    setDeskCalibration({
      enabled_regimes: ['RANGE', 'COMPRESSION'],
      soft_off_regimes: ['TREND_UP'],
    });
    expect(regimeAllowedForEntry('TREND_UP')).toBe(false);
    expect(regimeIsSoftOff('TREND_UP')).toBe(true);
    expect(regimeEntryPermitted('TREND_UP', { strong: false })).toBe(false);
    expect(regimeEntryPermitted('TREND_UP', { strong: true })).toBe(true);
    // BREAKOUT_UP not soft-off → Hard OFF
    expect(regimeIsSoftOff('BREAKOUT_UP')).toBe(false);
    expect(regimeEntryPermitted('BREAKOUT_UP', { strong: true })).toBe(false);
    expect(regimeEntryPermitted('RANGE')).toBe(true);
  });

  it('promoting to enabled clears Soft OFF overlap', () => {
    setDeskCalibration({
      enabled_regimes: ['TREND_UP', 'RANGE'],
      soft_off_regimes: ['TREND_UP', 'BREAKOUT_UP'],
    });
    const c = getDeskCalibration();
    expect(c.enabled_regimes.includes('TREND_UP')).toBe(true);
    expect(c.soft_off_regimes.includes('TREND_UP')).toBe(false);
    expect(c.soft_off_regimes.includes('BREAKOUT_UP')).toBe(true);
  });
});
