import { describe, expect, it } from 'vitest';
import { postCloseSetupCooldownMs } from './robotDesk.js';

describe('postCloseSetupCooldownMs — stop HardInv re-entry spam', () => {
  it('10s after normal close', () => {
    expect(postCloseSetupCooldownMs(0, 1_000_000)).toBe(10_000);
  });

  it('45s after HardInv (flip already done via pending path)', () => {
    const now = 1_000_000;
    expect(postCloseSetupCooldownMs(now - 5_000, now)).toBe(45_000);
  });

  it('back to 10s once HardInv window ages out', () => {
    const now = 1_000_000;
    expect(postCloseSetupCooldownMs(now - 181_000, now)).toBe(10_000);
  });
});
