/**
 * MAIN prototype — the only live Gold path on origin/main.
 *
 * ONE TEAM:
 *   C++ vs-calc  = scout — EntryReady propose only (never Capital)
 *   Node robotDesk = captain — validate setup, open Capital, Best Outcome close
 * Entry = real 10s setup + 0.40% safety SL.
 * Exit = Best Outcome close only (no zone manage, no SL trailing).
 */
import { SAFETY_SL_REL } from './capitalCom.js';

export const DESK_PROTOTYPE = 'MAIN' as const;
export const DESK_PROTOTYPE_SL = `${(SAFETY_SL_REL * 100).toFixed(2)}%-of-price` as const;
export const DESK_PROTOTYPE_STRATEGY = 'main-prototype-10s-sl040-exit';

export function deskPrototypeRules(): string {
  return (
    `MAIN PROTOTYPE · TEAM C++ scout + Node captain · Entry SL ${(SAFETY_SL_REL * 100).toFixed(2)}% (${SAFETY_SL_REL.toFixed(4)})` +
    ' · Exit Best Outcome close only · max 1 open · no flip every 10s candle'
  );
}
