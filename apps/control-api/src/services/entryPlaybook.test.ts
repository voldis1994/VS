import { describe, expect, it } from 'vitest';
import {
  pickEntryPlaybook,
  setupAllowedOnLane,
  capitalHtfBias,
} from './entryPlaybook.js';

describe('entryPlaybook — split brains (who looks at what)', () => {
  it('BREAKOUT lane owns BREAK_DOWN story even when live says RANGE', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'RANGE',
      story: { allow: 'SELL', chapter: 'BREAK_DOWN' },
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
    });
    expect(p.lane).toBe('BREAKOUT');
    expect(p.regime).toBe('BREAKOUT_DOWN');
    expect(setupAllowedOnLane(p.lane, 'FADE')).toBe(false);
    expect(setupAllowedOnLane(p.lane, 'BREAKOUT')).toBe(true);
  });

  it('TREND lane owns Capital HTF DOWN — RANGE fade blocked', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'RANGE',
      story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
      htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN' },
    });
    expect(p.lane).toBe('TREND_PULLBACK');
    expect(p.regime).toBe('TREND_DOWN');
    expect(setupAllowedOnLane(p.lane, 'FADE')).toBe(false);
    expect(setupAllowedOnLane(p.lane, 'PULLBACK')).toBe(true);
  });

  it('RANGE_FADE only when HTF flat/mixed and chop story', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'RANGE',
      story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
    });
    expect(p.lane).toBe('RANGE_FADE');
    expect(p.regime).toBe('RANGE');
    expect(setupAllowedOnLane(p.lane, 'FADE')).toBe(true);
  });

  it('live TREND/BREAKOUT never demoted by chop story', () => {
    expect(
      pickEntryPlaybook({
        liveRegime: 'TREND_UP',
        story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
        htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN' },
      }).regime
    ).toBe('TREND_UP');
    expect(
      pickEntryPlaybook({
        liveRegime: 'BREAKOUT_DOWN',
        story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
      }).lane
    ).toBe('BREAKOUT');
  });

  it('capitalHtfBias uses majority of 30/15/5', () => {
    expect(capitalHtfBias({ tf30: 'UP', tf15: 'UP', tf5: 'DOWN' })).toBe('UP');
    expect(capitalHtfBias({ tf30: 'UP', tf15: 'DOWN', tf5: 'FLAT' })).toBe('MIXED');
    expect(capitalHtfBias({ tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT', m1: 'DOWN' })).toBe(
      'DOWN'
    );
  });
});
