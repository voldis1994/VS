/**
 * MAIN prototype — the only live Gold path on origin/main.
 *
 * C++ vs-calc = EntryReady queue only (never Capital).
 * Node robotDesk = BUY/SELL on closed 10s + Capital hands.
 * Entry = order + 0.15% safety SL. Exit = Best Outcome close only (no SL trailing).
 */
import { SAFETY_SL_REL } from './capitalCom.js';

export const DESK_PROTOTYPE = 'MAIN' as const;
export const DESK_PROTOTYPE_SL = '0.15%-of-price' as const;
export const DESK_PROTOTYPE_STRATEGY = 'main-prototype-10s-sl015-exit';

export function deskPrototypeRules(): string {
  return (
    `MAIN PROTOTYPE · closed 10s BUY/SELL · Entry SL ${(SAFETY_SL_REL * 100).toFixed(2)}% (0.00150)` +
    ' · Exit Best Outcome close only · max 1 open · no flip every 10s candle'
  );
}
