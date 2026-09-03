import { describe, expect, it } from 'vitest';
import {
  isFlipExitReason,
  postExitEntryGate,
  POST_EXIT_COOLDOWN_MS,
} from './exitReentry.js';

describe('exitReentry — MoveFlip switches, other exits cool down', () => {
  it('detects MoveFlip / ThesisFailure as flip exits', () => {
    expect(isFlipExitReason('MoveFlip · BUY vs V-flip DOWN · CONTINUATION')).toBe(true);
    expect(isFlipExitReason('ThesisFailure · leg BUY vs 1m flow DOWN · LONG')).toBe(true);
    expect(isFlipExitReason('PeakProtection · LONG · retention 50%')).toBe(false);
    expect(isFlipExitReason('EarlyCut · LONG')).toBe(false);
  });

  it('allows immediate reverse after MoveFlip (no 5m cool-down)', () => {
    const now = 1_000_000;
    const g = postExitEntryGate({
      nowMs: now + 60_000, // 1m later
      lastExitMs: now,
      lastExitSide: 'BUY',
      lastExitReason: 'MoveFlip · BUY vs V-flip DOWN · CONTINUATION',
      entryDirection: 'SELL',
      flow: 'DOWN',
      vflip: 'DOWN',
    });
    expect(g.allow).toBe(true);
  });

  it('blocks reverse within 5m after PeakProtection (not a flip exit)', () => {
    const now = 1_000_000;
    const g = postExitEntryGate({
      nowMs: now + 60_000,
      lastExitMs: now,
      lastExitSide: 'BUY',
      lastExitReason: 'PeakProtection · LONG · retention 50%',
      entryDirection: 'SELL',
      flow: 'DOWN',
      vflip: 'DOWN',
    });
    expect(g.allow).toBe(false);
    expect(g.detail).toMatch(/cool-down/i);
  });

  it('blocks same-side spam after MoveFlip until flow flips', () => {
    const now = 1_000_000;
    const g = postExitEntryGate({
      nowMs: now + 60_000,
      lastExitMs: now,
      lastExitSide: 'BUY',
      lastExitReason: 'MoveFlip · BUY vs V-flip DOWN · CONTINUATION',
      entryDirection: 'BUY',
      flow: 'UP',
      vflip: null,
    });
    expect(g.allow).toBe(false);
    expect(g.detail).toMatch(/same-side dead/i);
  });

  it('after cool-down non-flip reverse still needs V-flip inside 8m', () => {
    const now = 1_000_000;
    const afterCool = now + POST_EXIT_COOLDOWN_MS + 1_000;
    const blocked = postExitEntryGate({
      nowMs: afterCool,
      lastExitMs: now,
      lastExitSide: 'BUY',
      lastExitReason: 'Target · LONG',
      entryDirection: 'SELL',
      flow: 'DOWN',
      vflip: null,
    });
    expect(blocked.allow).toBe(false);
    expect(blocked.detail).toMatch(/V-flip/i);

    const ok = postExitEntryGate({
      nowMs: afterCool,
      lastExitMs: now,
      lastExitSide: 'BUY',
      lastExitReason: 'Target · LONG',
      entryDirection: 'SELL',
      flow: 'DOWN',
      vflip: 'DOWN',
    });
    expect(ok.allow).toBe(true);
  });
});
