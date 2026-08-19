/**
 * MAIN prototype — the only live Gold path on origin/main.
 *
 * C++ vs-calc = EntryReady queue only (never Capital).
 * Node robotDesk = BUY/SELL on closed 10s + Capital hands.
 * Safety SL = 0.25% of price (0.00250). Best Outcome = SL to breakeven only.
 */
import { SAFETY_SL_REL } from './capitalCom.js';

export const DESK_PROTOTYPE = 'MAIN' as const;
export const DESK_PROTOTYPE_SL = '0.25%-of-price' as const;
export const DESK_PROTOTYPE_STRATEGY = 'main-prototype-10s-sl025-be';

export function deskPrototypeRules(): string {
  return (
    `MAIN PROTOTYPE · closed 10s BUY/SELL · SL ${(SAFETY_SL_REL * 100).toFixed(2)}% (0.00250)` +
    ' · Best Outcome SL→BE · max 1 open · ghost intents released when Capital flat'
  );
}
