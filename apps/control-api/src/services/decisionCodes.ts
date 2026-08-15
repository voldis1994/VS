/**
 * Production decision codes.
 *
 * Decision model:
 *   TRADE INTENT  → SIGNAL_CREATED / ENTER path (BUY|SELL)
 *   NO TRADE      → NO_SETUP (not an error, not a WAIT trading mode)
 *   SYSTEM PROBLEM → BLOCKED_TECHNICAL + precise reason (via risk/detail)
 *
 * UNKNOWN as a decision outcome is forbidden.
 * Artificial WAIT_* trading modes (cooldown, daily loss, max trades) are forbidden.
 *
 * Legacy WAIT_* codes remain only as aliases for older ticks / regression migration;
 * new code paths must emit NO_SETUP or BLOCKED_TECHNICAL.
 */

export const DecisionCodes = {
  /** No valid strategy setup on this event — continue scanning next market event. */
  NO_SETUP: 'NO_SETUP',
  /** Technical safety blocked execution — not a strategy judgment. */
  BLOCKED_TECHNICAL: 'BLOCKED_TECHNICAL',

  // Legacy aliases (prefer NO_SETUP / BLOCKED_TECHNICAL)
  WAIT_NO_SETUP: 'NO_SETUP',
  WAIT_BAR_FORMING: 'NO_SETUP',
  WAIT_NO_FADE: 'NO_SETUP',
  WAIT_COUNTERTREND: 'NO_SETUP',
  WAIT_LATE_MOVE: 'NO_SETUP',
  WAIT_INSUFFICIENT_EVIDENCE: 'NO_SETUP',
  /** @deprecated artificial — must not block execution */
  WAIT_COOLDOWN: 'BLOCKED_TECHNICAL',
  WAIT_MARKET_CLOSED: 'BLOCKED_TECHNICAL',
  WAIT_STALE_FEED: 'BLOCKED_TECHNICAL',
  WAIT_SPREAD_TOO_HIGH: 'BLOCKED_TECHNICAL',
  /** @deprecated was misused for reconcile failure — use BLOCKED_TECHNICAL */
  WAIT_RISK_LIMIT: 'BLOCKED_TECHNICAL',
  WAIT_MANAGE_ONLY: 'BLOCKED_TECHNICAL',
  WAIT_TRADING_OFF: 'BLOCKED_TECHNICAL',

  // Entry progression
  SIGNAL_CREATED: 'SIGNAL_CREATED',
  RISK_ACCEPTED: 'RISK_ACCEPTED',
  ORDER_SUBMITTING: 'ORDER_SUBMITTING',
  BROKER_ACCEPTED: 'BROKER_ACCEPTED',
  BROKER_REJECTED: 'BROKER_REJECTED',
  FILLED: 'FILLED',
  POSITION_OPEN: 'POSITION_OPEN',
  POSITION_CLOSED: 'POSITION_CLOSED',

  // Hard failures
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

/** @deprecated WAIT is not a trading mode — use isNoSetup / isTechnicalBlock */
export function isWaitCode(code: DecisionCode | string): boolean {
  return code === DecisionCodes.NO_SETUP || String(code).startsWith('WAIT_');
}

export function isNoSetup(code: DecisionCode | string): boolean {
  return code === DecisionCodes.NO_SETUP || code === 'WAIT_NO_SETUP' || code === 'WAIT_BAR_FORMING' || code === 'WAIT_NO_FADE' || code === 'WAIT_COUNTERTREND' || code === 'WAIT_LATE_MOVE';
}

export function isTechnicalBlock(code: DecisionCode | string): boolean {
  return (
    code === DecisionCodes.BLOCKED_TECHNICAL ||
    code === DecisionCodes.RISK_REJECTED ||
    code === DecisionCodes.DUPLICATE_PREVENTED ||
    code === DecisionCodes.STALE_PRICE ||
    code === DecisionCodes.MARKET_CLOSED ||
    code === DecisionCodes.RATE_LIMITED ||
    String(code).startsWith('RISK_REJECTED_')
  );
}

export function isErrorCode(code: DecisionCode): boolean {
  return (
    code.startsWith('ERROR_') ||
    code === DecisionCodes.NETWORK_TIMEOUT ||
    code === DecisionCodes.SESSION_EXPIRED ||
    code === DecisionCodes.RATE_LIMITED ||
    code === DecisionCodes.BROKER_REJECTED ||
    code === DecisionCodes.STALE_PRICE ||
    code === DecisionCodes.RISK_REJECTED ||
    code === DecisionCodes.MARKET_CLOSED ||
    code === DecisionCodes.DUPLICATE_PREVENTED ||
    code === DecisionCodes.BLOCKED_TECHNICAL
  );
}

/** Human Latvian/EN short line for operators — never invent status. */
export function humanDecision(code: DecisionCode | string): string {
  switch (code) {
    case DecisionCodes.NO_SETUP:
    case 'WAIT_NO_SETUP':
      return 'Nav setup — turpina lasīt nākamo market event';
    case 'WAIT_BAR_FORMING':
      return 'Nav closed 10s bar — nav setup';
    case DecisionCodes.BLOCKED_TECHNICAL:
    case 'WAIT_COOLDOWN':
    case 'WAIT_RISK_LIMIT':
      return 'Tehniski bloķēts — skaties error code';
    case 'WAIT_MARKET_CLOSED':
    case DecisionCodes.MARKET_CLOSED:
      return 'Capital marketStatus nav TRADEABLE/OPEN';
    case 'WAIT_STALE_FEED':
    case DecisionCodes.STALE_PRICE:
      return 'PRIMARY feed stale/offline';
    case 'WAIT_LATE_MOVE':
      return '1m svece jau aizskrējusi trade virzienā — nav valid setup';
    case 'WAIT_MANAGE_ONLY':
      return 'Manage-only — lokālais entry brain izslēgts';
    case 'WAIT_TRADING_OFF':
      return 'Trading OFF — tikai lasīšana';
    case 'WAIT_COUNTERTREND':
      return 'Countertrend / with-trend veto — nav valid setup';
    case 'WAIT_NO_FADE':
      return 'RANGE/fade/reversal — ieeja aizliegta (strategy)';
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
      return String(code);
  }
}
