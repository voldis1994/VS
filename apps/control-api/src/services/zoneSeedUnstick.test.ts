import { describe, expect, it } from 'vitest';
import { shouldAttemptZoneSeed } from './robotDesk.js';
import { MIN_BARS_FOR_ZONE } from './regimes.js';

describe('shouldAttemptZoneSeed — do not starve zone on multi-feed', () => {
  it('attempts seed when book is empty (first tick)', () => {
    expect(shouldAttemptZoneSeed(0, 0, 20_000)).toBe(true);
  });

  it('attempts seed while book is thin below MIN_BARS', () => {
    expect(shouldAttemptZoneSeed(45, 0, 20_000)).toBe(true);
  });

  it('does not seed once min zone is filled', () => {
    expect(shouldAttemptZoneSeed(MIN_BARS_FOR_ZONE, 0, 20_000)).toBe(false);
    expect(shouldAttemptZoneSeed(MIN_BARS_FOR_ZONE + 10, 0, 99_000)).toBe(false);
  });

  it('throttles repeat seed attempts', () => {
    const last = 100_000;
    expect(shouldAttemptZoneSeed(10, last, last + 5_000)).toBe(false);
    expect(shouldAttemptZoneSeed(10, last, last + 15_000)).toBe(true);
  });
});
