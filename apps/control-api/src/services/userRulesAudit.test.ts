/**
 * Executable audit — USER trading rules vs live desk helpers.
 * Failures mean the desk drifted from what the user ordered.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  hardInvFlipBrokerAction,
  hardInvOppositeScalpSide,
  type ExitSnapshot,
} from './exitManage.js';
import { decideEntryFromArmedLive, emptySetup } from './marketSetup.js';
import { exitParamsForTrade } from './playbooks.js';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: ago(60_000),
    regime: 'TREND_UP',
    playbook: 'LONG',
    ...partial,
  };
}

const deskSrc = readFileSync(fileURLToPath(new URL('./robotDesk.ts', import.meta.url)), 'utf8');
const exitSrc = readFileSync(fileURLToPath(new URL('./exitManage.ts', import.meta.url)), 'utf8');

describe('USER RULE 1 — ARMED live mid entry (no 1m wait)', () => {
  it('decideEntryFromArmedLive fires on ARMED mid without candle confirm', () => {
    const setup = {
      ...emptySetup(),
      kind: 'CONTINUATION' as const,
      side: 'BUY' as const,
      playbook: 'LONG' as const,
      status: 'ARMED' as const,
      confirm: 2,
      reason: 'CONTINUATION BUY',
    };
    const e = decideEntryFromArmedLive(setup, 2005, null, 'TREND_UP');
    expect(e).not.toBeNull();
    expect(e!.reason).toMatch(/no 1m wait|live mid/i);
  });

  it('desk wires decideEntryFromArmedLive and has no agent entry pause constants', () => {
    expect(deskSrc).toMatch(/decideEntryFromArmedLive/);
    expect(deskSrc).toMatch(/no Capital 1m close confirmation|live mid entry \(no 1m wait\)|no 1m wait/);
    // Active gates must stay gone (comments mentioning removal are OK)
    expect(deskSrc).not.toMatch(/ENTRY_DEBOUNCE_MS\s*=/);
    expect(deskSrc).not.toMatch(/SIDE_LOCK_AFTER_\w+\s*=/);
    expect(deskSrc).not.toMatch(/COOLDOWN_AFTER_\w+\s*=/);
    expect(deskSrc).not.toMatch(/detail: `[^`]*entry debounce/);
    expect(deskSrc).not.toMatch(/detail: `[^`]*side-lock/);
    expect(deskSrc).not.toMatch(/detail: `[^`]*cooldown \d+s after close/);
  });
});

describe('USER RULE 2 — profit 1m continue HOLD / reverse PeakProtect', () => {
  it('continue → HOLD policy; reverse → PeakProtect arm signal', () => {
    expect(
      closed1mProfitPolicy('BUY', { open: 2000, close: 2003 }, { open: 1998, close: 2000 })
    ).toBe('continue');
    expect(
      closed1mProfitPolicy('BUY', { open: 2003, close: 2000 }, { open: 2000, close: 2003 })
    ).toBe('reverse');
  });

  it('desk HOLDs on continue and arms PeakProtect-only on reverse (no DirectionFlip)', () => {
    expect(deskSrc).toMatch(/1m continue · HOLD profit · PeakProtect OFF/);
    expect(deskSrc).toMatch(/1m reverse · PeakProtect ARMED/);
    expect(deskSrc).toMatch(/peak_protect_only/);
    expect(deskSrc).not.toMatch(/directionFlipExitReason\(/);
  });

  it('peak_protect_only fires PeakProtect but never Target / TimeDecay', () => {
    const giveback = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 4,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      2002.5,
      'peak_protect_only'
    );
    expect(giveback.exit).toBe(true);
    expect(giveback.reason).toMatch(/PeakProtection/);

    const deepGreen = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 20,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      2025,
      'peak_protect_only'
    );
    expect(deepGreen.exit).toBe(false);
  });
});

describe('USER RULE 3 — HardInv live + opposite SCALP flip, no chain', () => {
  it('live_loss only HardInv (no ThesisFailure scratch)', () => {
    const hard = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, playbook: 'SCALP', mfe: 0 }),
      1998.4,
      'live_loss'
    );
    expect(hard.exit).toBe(true);
    expect(hard.reason).toMatch(/HardInvalidation/);

    const mildRed = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(200_000),
        playbook: 'LONG',
        regime: 'TREND_DOWN',
        entry_regime: 'TREND_DOWN',
        mfe: 1,
      }),
      1999.5,
      'live_loss'
    );
    expect(mildRed.exit).toBe(false);
    expect(exitSrc).toMatch(/ThesisFailure disabled|HardInv only/);
  });

  it('HardInv arms opposite SCALP once; HARDINV_FLIP does not chain', () => {
    expect(hardInvOppositeScalpSide('HardInvalidation · SCALP', 'BUY', 'CONTINUATION')).toBe(
      'SELL'
    );
    expect(hardInvOppositeScalpSide('HardInvalidation · SCALP', 'BUY', 'HARDINV_FLIP')).toBeNull();
    expect(hardInvFlipBrokerAction('SELL', 'BUY')).toBe('wait_clear');
    expect(hardInvFlipBrokerAction('SELL', null)).toBe('enter');
    expect(hardInvFlipBrokerAction('SELL', 'SELL')).toBe('adopt_flip');
  });

  it('desk flips same cycle without 1m wait and force-closes ghost', () => {
    expect(deskSrc).toMatch(/HARDINV FLIP armed/);
    expect(deskSrc).toMatch(/no 1m wait/);
    expect(deskSrc).toMatch(/force-close ghost/);
    expect(deskSrc).toMatch(/HardInv flip FIRST/);
    expect(deskSrc).toMatch(/HARDINV_FLIP_EXPIRE_MS = 60_000/);
  });
});

describe('USER RULE 4 — no agent cooldown / side-lock / debounce constants', () => {
  it('robotDesk has no post-close cooldown / side-lock / debounce constants', () => {
    expect(deskSrc).not.toMatch(/COOLDOWN_AFTER_HARD_MS\s*=/);
    expect(deskSrc).not.toMatch(/COOLDOWN_AFTER_SOFT_MS\s*=/);
    expect(deskSrc).not.toMatch(/SIDE_LOCK_AFTER_HARD_MS\s*=/);
    expect(deskSrc).not.toMatch(/ENTRY_DEBOUNCE_MS\s*=/);
    expect(deskSrc).toMatch(/No post-close cooldown/);
    expect(deskSrc).toMatch(/No entry debounce \/ side-lock/);
  });
});

describe('USER RULE 5 — playbook knobs still explicit', () => {
  it('HardInv 1.5pt all books; PeakProtect LONG 75% / SCALP 90%', () => {
    const long = exitParamsForTrade('LONG', 'CONTINUATION');
    const scalp = exitParamsForTrade('SCALP', 'PULLBACK');
    expect(long.slFloor).toBe(1.5);
    expect(long.slCapAbs).toBe(1.5);
    expect(scalp.slFloor).toBe(1.5);
    expect(long.peakRet).toBe(0.75);
    expect(scalp.peakRet).toBe(0.9);
  });
});
