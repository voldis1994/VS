import { describe, expect, it } from 'vitest';

/**
 * Mirror of robotDesk BROKER_FLAT_CONFIRM policy — keep in sync with
 * confirmBrokerFlatWhileLocalOpen in robotDesk.ts.
 */
const BROKER_FLAT_CONFIRM = 3;

function confirmStreak(streak: number): { next: number; clear: boolean } {
  const next = streak + 1;
  return { next, clear: next >= BROKER_FLAT_CONFIRM };
}

describe('broker flat debounce (API blip ≠ close)', () => {
  it('one empty Capital list does not clear open trade', () => {
    expect(confirmStreak(0).clear).toBe(false);
    expect(confirmStreak(1).clear).toBe(false);
  });

  it('third consecutive empty list may clear', () => {
    let s = 0;
    for (let i = 0; i < BROKER_FLAT_CONFIRM - 1; i++) {
      const r = confirmStreak(s);
      expect(r.clear).toBe(false);
      s = r.next;
    }
    expect(confirmStreak(s).clear).toBe(true);
  });
});
