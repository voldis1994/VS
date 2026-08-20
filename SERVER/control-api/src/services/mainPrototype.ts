/**
 * MAIN prototype — the only live Gold path on origin/main.
 *
 * C++ vs-calc = EntryReady queue only (never Capital).
 * Node robotDesk = BUY/SELL on closed 10s + Capital hands.
 * Entry = order + 0.40% safety SL. Exit = zone take-profit / reverse + Best Outcome close.
 */
import { SAFETY_SL_REL } from './capitalCom.js';

export const DESK_PROTOTYPE = 'MAIN' as const;
export const DESK_PROTOTYPE_SL = `${(SAFETY_SL_REL * 100).toFixed(2)}%-of-price` as const;
export const DESK_PROTOTYPE_STRATEGY = 'main-prototype-10s-sl040-exit';

export function deskPrototypeRules(): string {
  return (
    `MAIN PROTOTYPE · closed 10s BUY/SELL · Entry SL ${(SAFETY_SL_REL * 100).toFixed(2)}% (${SAFETY_SL_REL.toFixed(4)})` +
    ' · Exit zones TP + Best Outcome · max 1 open · no flip every 10s candle'
  );
}
