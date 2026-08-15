/**
 * Production decision codes.
 *
 * Decision model:
 *   TRADE INTENT  → SIGNAL_CREATED (BUY|SELL via ENTER path)
 *   NO TRADE      → NO_SETUP
 *   SYSTEM PROBLEM → BLOCKED_TECHNICAL (+ precise risk/error code in detail)
 *
 * UNKNOWN is forbidden as a Strategy decision.
 * WAIT_* is forbidden as a trading state — see decisionCompat.ts for log migration only.
 */

export const DecisionCodes = {
  NO_SETUP: 'NO_SETUP',
  BLOCKED_TECHNICAL: 'BLOCKED_TECHNICAL',

  SIGNAL_CREATED: 'SIGNAL_CREATED',
  RISK_ACCEPTED: 'RISK_ACCEPTED',
  ORDER_SUBMITTING: 'ORDER_SUBMITTING',
  BROKER_ACCEPTED: 'BROKER_ACCEPTED',
  BROKER_REJECTED: 'BROKER_REJECTED',
  /** Timeout / ambiguous broker response — not a Strategy UNKNOWN. */
  BROKER_RESULT_UNRESOLVED: 'BROKER_RESULT_UNRESOLVED',
  FILLED: 'FILLED',
  POSITION_OPEN: 'POSITION_OPEN',
  POSITION_CLOSED: 'POSITION_CLOSED',

  ERROR_STATE_UNRESOLVED: 'ERROR_STATE_UNRESOLVED',
  ERROR_NO_QUOTE: 'ERROR_NO_QUOTE',
  ERROR_SESSION: 'ERROR_SESSION',
  ERROR_BROKER: 'ERROR_BROKER',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  DUPLICATE_PREVENTED: 'DUPLICATE_PREVENTED',
  STALE_PRICE: 'STALE_PRICE',
  RISK_REJECTED: 'RISK_REJECTED',
  MARKET_CLOSED: 'MARKET_CLOSED',
} as const;

export type DecisionCode = (typeof DecisionCodes)[keyof typeof DecisionCodes];

export type DecisionEvent = {
  code: DecisionCode;
  at: string;
  detail: string;
  epic?: string;
  account_id?: number;
};

export function isNoSetup(code: DecisionCode | string): boolean {
  return code === DecisionCodes.NO_SETUP;
}

export function isTechnicalBlock(code: DecisionCode | string): boolean {
  return (
    code === DecisionCodes.BLOCKED_TECHNICAL ||
    code === DecisionCodes.RISK_REJECTED ||
    code === DecisionCodes.DUPLICATE_PREVENTED ||
    code === DecisionCodes.STALE_PRICE ||
    code === DecisionCodes.MARKET_CLOSED ||
    code === DecisionCodes.RATE_LIMITED ||
    code === DecisionCodes.BROKER_RESULT_UNRESOLVED ||
    code === DecisionCodes.NETWORK_TIMEOUT ||
    String(code).startsWith('RISK_REJECTED_')
  );
}

/** @deprecated WAIT is not a trading mode */
export function isWaitCode(code: DecisionCode | string): boolean {
  return isNoSetup(code) || String(code).startsWith('WAIT_');
}

export function isErrorCode(code: DecisionCode | string): boolean {
  return (
    String(code).startsWith('ERROR_') ||
    code === DecisionCodes.NETWORK_TIMEOUT ||
    code === DecisionCodes.SESSION_EXPIRED ||
    code === DecisionCodes.RATE_LIMITED ||
    code === DecisionCodes.BROKER_REJECTED ||
    code === DecisionCodes.STALE_PRICE ||
    code === DecisionCodes.RISK_REJECTED ||
    code === DecisionCodes.MARKET_CLOSED ||
    code === DecisionCodes.DUPLICATE_PREVENTED ||
    code === DecisionCodes.BLOCKED_TECHNICAL ||
    code === DecisionCodes.BROKER_RESULT_UNRESOLVED
  );
}

export function humanDecision(code: DecisionCode | string): string {
  switch (code) {
    case DecisionCodes.NO_SETUP:
      return 'Nav setup — turpina lasīt nākamo market event';
    case DecisionCodes.BLOCKED_TECHNICAL:
      return 'Tehniski bloķēts — skaties error code';
    case DecisionCodes.BROKER_RESULT_UNRESOLVED:
      return 'Broker rezultāts neskaidrs — reconcile, bez blind retry';
    case DecisionCodes.MARKET_CLOSED:
      return 'Capital marketStatus nav TRADEABLE/OPEN';
    case DecisionCodes.STALE_PRICE:
      return 'PRIMARY feed stale/offline';
    case DecisionCodes.ERROR_STATE_UNRESOLVED:
      return 'Stāvoklis nav atrisināts — ERROR';
    case DecisionCodes.ERROR_NO_QUOTE:
      return 'Nav Capital quote';
    case DecisionCodes.ERROR_SESSION:
      return 'Capital session kļūda';
    case DecisionCodes.RATE_LIMITED:
      return 'Capital rate limit';
    case DecisionCodes.DUPLICATE_PREVENTED:
      return 'Duplicate / open position — jauns orderis bloķēts';
    case DecisionCodes.BROKER_REJECTED:
      return 'Capital noraidīja orderi';
    case DecisionCodes.SIGNAL_CREATED:
      return 'Valid setup → trade intent';
    case DecisionCodes.ORDER_SUBMITTING:
      return 'Sūta orderi uz Capital';
    case DecisionCodes.FILLED:
      return 'Fill / pozīcija atvērta';
    default:
      // Legacy log strings only — do not emit these from new decisions
      if (String(code).startsWith('WAIT_')) {
        return `Legacy ${code} (mapped — not a live trading state)`;
      }
      return String(code);
  }
}
