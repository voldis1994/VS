/**
 * Post-exit re-entry policy — exit & switch on MoveFlip, cool-down on chop exits.
 * 1m/10s desk: after a soft harvest, mid-leg CONTINUATION may resume while dump owns tape.
 */

export const POST_EXIT_COOLDOWN_MS = 5 * 60_000;
export const REVERSE_VFLIP_WINDOW_MS = 8 * 60_000;
/** Same-side dump/rally resume after soft exit — 2m (not forever flat mid-dump) */
export const SAME_SIDE_CONTINUE_MS = 2 * 60_000;

/** MoveFlip / against-flow thesis — the tape already turned; reverse is the trade. */
export function isFlipExitReason(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  return /MoveFlip/i.test(r) || /ThesisFailure/i.test(r);
}

/** Soft harvest exits — OK to resume same-side mid-leg if flow still agrees. */
export function isSoftHarvestExit(reason: string | null | undefined): boolean {
  return /PeakProtection|BestOutcome|Target|ProfitGiveback|TimeDecay/i.test(String(reason || ''));
}

/** True BREAKOUT through swing — not impulse-confirm blip. */
export function isThroughLevelBreakout(
  setup: string | null | undefined,
  reason: string | null | undefined
): boolean {
  if (String(setup || '').toUpperCase() !== 'BREAKOUT') return false;
  return /through H|through L|BREAKOUT (BUY|SELL) through/i.test(String(reason || ''));
}

/** Mid-swing / flow-flip CONTINUATION only — not tip CONTINUATION up/down or IMPULSE → */
export function isDumpRideContinuationEntry(
  setup: string | null | undefined,
  reason: string | null | undefined
): boolean {
  if (String(setup || '').toUpperCase() !== 'CONTINUATION') return false;
  const r = String(reason || '');
  if (/IMPULSE (UP|DOWN) →/.test(r)) return false;
  return /mid-swing|FLOW flip mid-leg|IMPULSE (UP|DOWN) mid-leg/i.test(r);
}

/**
 * After an exit, may we take this entry?
 * - MoveFlip / ThesisFailure → reverse allowed immediately (next 1m bar is separate)
 * - Other exits → 5m cool-down; reverse still needs V-flip for 8m
 * - Same side → normally dead until flow flips; EXCEPT:
 *   - through-level BREAKOUT after 5m cool-down
 *   - mid-swing CONTINUATION after soft harvest while flow still agrees (1m dump ride)
 */
export function postExitEntryGate(opts: {
  nowMs: number;
  lastExitMs: number;
  lastExitSide: 'BUY' | 'SELL' | null;
  lastExitReason: string | null | undefined;
  entryDirection: 'BUY' | 'SELL';
  flow: 'UP' | 'DOWN' | null;
  vflip: 'UP' | 'DOWN' | null;
  entrySetup?: string | null;
  entryReason?: string | null;
}): { allow: boolean; detail: string | null } {
  const {
    nowMs,
    lastExitMs,
    lastExitSide,
    lastExitReason,
    entryDirection,
    flow,
    vflip,
    entrySetup,
    entryReason,
  } = opts;
  if (!lastExitSide || !(lastExitMs > 0)) return { allow: true, detail: null };

  const age = nowMs - lastExitMs;
  const reverse = entryDirection !== lastExitSide;
  const flipExit = isFlipExitReason(lastExitReason);

  if (!reverse) {
    // Through-level BREAKOUT may continue the day after cool-down (don't miss 13:22 class)
    if (
      isThroughLevelBreakout(entrySetup, entryReason) &&
      age >= POST_EXIT_COOLDOWN_MS
    ) {
      return { allow: true, detail: null };
    }
    // 1m dump ride: soft harvest → re-SELL while flow still DOWN (not EarlyCut spam)
    const flowContinues =
      (lastExitSide === 'SELL' && flow === 'DOWN') ||
      (lastExitSide === 'BUY' && flow === 'UP');
    if (
      flowContinues &&
      isSoftHarvestExit(lastExitReason) &&
      isDumpRideContinuationEntry(entrySetup, entryReason) &&
      age >= SAME_SIDE_CONTINUE_MS
    ) {
      return { allow: true, detail: null };
    }
    const flowFlipped =
      (lastExitSide === 'BUY' && flow === 'DOWN') ||
      (lastExitSide === 'SELL' && flow === 'UP');
    if (!flowFlipped) {
      return {
        allow: false,
        detail: `same-side dead ${lastExitSide} until flip (flow ${flow || '—'}) · no spam re-entry`,
      };
    }
    if (age < POST_EXIT_COOLDOWN_MS) {
      const left = Math.ceil((POST_EXIT_COOLDOWN_MS - age) / 1000);
      return { allow: false, detail: `post-exit cool-down ${left}s · quality over frequency` };
    }
    return { allow: true, detail: null };
  }

  // Reverse after flip-exit — switch now (caller still waits next closed 1m)
  if (flipExit) {
    return { allow: true, detail: null };
  }

  if (age < POST_EXIT_COOLDOWN_MS) {
    const left = Math.ceil((POST_EXIT_COOLDOWN_MS - age) / 1000);
    return { allow: false, detail: `post-exit cool-down ${left}s · quality over frequency` };
  }

  if (age < REVERSE_VFLIP_WINDOW_MS) {
    const need: 'UP' | 'DOWN' = entryDirection === 'SELL' ? 'DOWN' : 'UP';
    if (vflip !== need) {
      return {
        allow: false,
        detail: `reverse blocked · need V-flip ${need} after ${lastExitSide} exit (have ${vflip || 'none'})`,
      };
    }
  }

  return { allow: true, detail: null };
}
