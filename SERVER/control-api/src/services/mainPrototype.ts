/**
 * MAIN prototype — the only live Gold path on origin/main.
 *
 * C++ SUPER vs-calc prepares EntryReady (all feeds + pressure + 1m/5m/15m + 200c).
 * Node robotDesk only executes: Capital open + Safety SL + Best Outcome close.
 * Node does NOT invent BUY/SELL when C++ is silent.
 */
import { SAFETY_SL_REL } from './capitalCom.js';

export const DESK_PROTOTYPE = 'MAIN' as const;
export const DESK_PROTOTYPE_SL = `${(SAFETY_SL_REL * 100).toFixed(2)}%-of-price` as const;
export const DESK_PROTOTYPE_STRATEGY = 'main-prototype-10s-sl040-exit';

export function deskPrototypeRules(): string {
  return (
    `MAIN PROTOTYPE · SUPER C++ entry (feeds+pressure+1m/5m/15m+200c) · Node executes Capital · Entry SL ${(SAFETY_SL_REL * 100).toFixed(2)}% (${SAFETY_SL_REL.toFixed(4)})` +
    ' · Exit Best Outcome close only · max 1 open · no flip every 10s candle'
  );
}
