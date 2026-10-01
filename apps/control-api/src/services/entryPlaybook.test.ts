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

  it('live chop + HTF DOWN stays SIDE — HTF does not steal RANGE_FADE', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'RANGE',
      story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
      htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN' },
    });
    expect(p.lane).toBe('RANGE_FADE');
    expect(p.regime).toBe('RANGE');
    expect(setupAllowedOnLane(p.lane, 'FADE')).toBe(true);
  });

  it('partial HTF (only 30m) does not invent TREND on live chop', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'RANGE',
      story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
      htf: { tf30: 'DOWN', tf15: null, tf5: null, m1: 'UP' },
    });
    expect(p.lane).toBe('RANGE_FADE');
    expect(p.regime).toBe('RANGE');
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

  it('live TREND keeps with clear HTF; demotes to SIDE on chop+flat HTF', () => {
    expect(
      pickEntryPlaybook({
        liveRegime: 'TREND_UP',
        story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
        htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN' },
      }).regime
    ).toBe('TREND_UP');
    expect(
      pickEntryPlaybook({
        liveRegime: 'TREND_DOWN',
        story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
        htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
      }).lane
    ).toBe('RANGE_FADE');
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

  it('EXHAUST_HI/LO + flat HTF stays RANGE book — not fake TREND (entry waits reject)', () => {
    const hi = pickEntryPlaybook({
      liveRegime: 'RANGE',
      story: { allow: 'BUY', chapter: 'EXHAUST_HI' },
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
    });
    expect(hi.lane).toBe('RANGE_FADE');
    expect(hi.regime).toBe('RANGE');
    expect(hi.why_lv).toMatch(/reject|tip/i);
    const lo = pickEntryPlaybook({
      liveRegime: 'COMPRESSION',
      story: { allow: 'SELL', chapter: 'EXHAUST_LO' },
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
    });
    expect(lo.lane).toBe('RANGE_FADE');
    expect(lo.regime).toBe('COMPRESSION');
  });

  it('unclear HTF/story on UNKNOWN waits — not RANGE fade', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'UNKNOWN',
      story: { allow: 'NONE', chapter: 'SEEDING' },
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
    });
    expect(p.lane).toBe('LIVE');
    expect(p.regime).toBe('UNKNOWN');
    expect(p.why_lv).toMatch(/WAIT|ne RANGE/i);
  });

  it('unclear story does not invent RANGE when live is TREND', () => {
    const p = pickEntryPlaybook({
      liveRegime: 'TREND_DOWN',
      story: { allow: 'BOTH', chapter: 'SEEDING' },
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT' },
    });
    expect(p.lane).toBe('TREND_PULLBACK');
    expect(p.regime).toBe('TREND_DOWN');
    expect(p.lane).not.toBe('RANGE_FADE');
  });

  it('priority: REVERSAL live wins; BREAK story on chop; SIDE before HTF', () => {
    expect(
      pickEntryPlaybook({
        liveRegime: 'REVERSAL_CANDIDATE',
        story: { allow: 'BUY', chapter: 'RALLY' },
        htf: { tf30: 'UP', tf15: 'UP', tf5: 'UP' },
      }).lane
    ).toBe('REVERSAL');
    expect(
      pickEntryPlaybook({
        liveRegime: 'RANGE',
        story: { allow: 'SELL', chapter: 'BREAK_DOWN' },
        htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN' },
      }).lane
    ).toBe('BREAKOUT');
    expect(
      pickEntryPlaybook({
        liveRegime: 'RANGE',
        story: { allow: 'BUY', chapter: 'RALLY' },
        htf: { tf30: 'UP', tf15: 'UP', tf5: 'UP' },
      }).lane
    ).toBe('RANGE_FADE');
  });
});
