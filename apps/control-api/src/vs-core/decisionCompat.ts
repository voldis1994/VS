/**
 * Compatibility layer for historical WAIT_* log/tick codes.
 * Does NOT participate in new trading decisions.
 * New code must emit NO_SETUP | BLOCKED_TECHNICAL | SIGNAL_* | ERROR_*.
 */

import { DecisionCodes, type DecisionCode } from '../services/decisionCodes.js';

/** Map a legacy wait string (from old logs) to the current decision model. */
export function mapLegacyWaitCode(raw: string): DecisionCode {
  const c = String(raw || '').trim().toUpperCase();
  switch (c) {
    case 'WAIT_NO_SETUP':
    case 'WAIT_BAR_FORMING':
    case 'WAIT_NO_FADE':
    case 'WAIT_COUNTERTREND':
    case 'WAIT_LATE_MOVE':
    case 'WAIT_INSUFFICIENT_EVIDENCE':
      return DecisionCodes.NO_SETUP;
    case 'WAIT_COOLDOWN':
    case 'WAIT_MARKET_CLOSED':
    case 'WAIT_STALE_FEED':
    case 'WAIT_SPREAD_TOO_HIGH':
    case 'WAIT_RISK_LIMIT':
    case 'WAIT_MANAGE_ONLY':
    case 'WAIT_TRADING_OFF':
      return DecisionCodes.BLOCKED_TECHNICAL;
    default:
      if (c.startsWith('WAIT_')) return DecisionCodes.BLOCKED_TECHNICAL;
      return (c as DecisionCode) || DecisionCodes.ERROR_STATE_UNRESOLVED;
  }
}

export function isLegacyWaitString(raw: string): boolean {
  return String(raw || '').toUpperCase().startsWith('WAIT_');
}
