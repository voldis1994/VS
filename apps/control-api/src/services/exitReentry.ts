/**
 * Post-exit re-entry policy — exit & switch on MoveFlip, cool-down on chop exits.
 */

export const POST_EXIT_COOLDOWN_MS = 5 * 60_000;
export const REVERSE_VFLIP_WINDOW_MS = 8 * 60_000;

/** MoveFlip / against-flow thesis — the tape already turned; reverse is the trade. */
export function isFlipExitReason(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  return /MoveFlip/i.test(r) || /ThesisFailure/i.test(r);
}

/**
 * After an exit, may we take this entry?
 * - MoveFlip / ThesisFailure → reverse allowed immediately (next 1m bar is separate)
 * - Other exits → 5m cool-down; reverse still needs V-flip for 8m
 * - Same side → dead until flow flips, then still cool-down
 */
export function postExitEntryGate(opts: {
  nowMs: number;
  lastExitMs: number;
  lastExitSide: 'BUY' | 'SELL' | null;
  lastExitReason: string | null | undefined;
  entryDirection: 'BUY' | 'SELL';
  flow: 'UP' | 'DOWN' | null;
  vflip: 'UP' | 'DOWN' | null;
}): { allow: boolean; detail: string | null } {
  const {
    nowMs,
    lastExitMs,
    lastExitSide,
    lastExitReason,
    entryDirection,
    flow,
    vflip,
  } = opts;
  if (!lastExitSide || !(lastExitMs > 0)) return { allow: true, detail: null };

  const age = nowMs - lastExitMs;
  const reverse = entryDirection !== lastExitSide;
  const flipExit = isFlipExitReason(lastExitReason);

  if (!reverse) {
    const flowOk =
      (lastExitSide === 'BUY' && flow === 'DOWN') ||
      (lastExitSide === 'SELL' && flow === 'UP');
    if (!flowOk) {
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
