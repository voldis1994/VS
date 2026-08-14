/**
 * Production decision / wait / block reason codes.
 * UI may only display these when the matching runtime gate actually fired.
 * UNKNOWN as a decision outcome is forbidden — use ERROR_STATE_UNRESOLVED.
 */

export const DecisionCodes = {
  // Wait (strategy / market — not errors)
  WAIT_NO_SETUP: 'WAIT_NO_SETUP',
  WAIT_BAR_FORMING: 'WAIT_BAR_FORMING',
  WAIT_COOLDOWN: 'WAIT_COOLDOWN',
  WAIT_MARKET_CLOSED: 'WAIT_MARKET_CLOSED',
  WAIT_STALE_FEED: 'WAIT_STALE_FEED',
  WAIT_LATE_MOVE: 'WAIT_LATE_MOVE',
  WAIT_SPREAD_TOO_HIGH: 'WAIT_SPREAD_TOO_HIGH',
  WAIT_INSUFFICIENT_EVIDENCE: 'WAIT_INSUFFICIENT_EVIDENCE',
  WAIT_RISK_LIMIT: 'WAIT_RISK_LIMIT',
  WAIT_MANAGE_ONLY: 'WAIT_MANAGE_ONLY',
  WAIT_TRADING_OFF: 'WAIT_TRADING_OFF',
  WAIT_COUNTERTREND: 'WAIT_COUNTERTREND',
  WAIT_NO_FADE: 'WAIT_NO_FADE',

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

export function isWaitCode(code: DecisionCode): boolean {
  return code.startsWith('WAIT_');
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
    code === DecisionCodes.DUPLICATE_PREVENTED
  );
}

/** Human Latvian/EN short line for operators — never invent status. */
export function humanDecision(code: DecisionCode): string {
  switch (code) {
    case DecisionCodes.WAIT_NO_SETUP:
      return 'Gaida setup — šajā 10s close nav with-trend ieejas';
    case DecisionCodes.WAIT_BAR_FORMING:
      return 'Gaida 10s sveces close';
    case DecisionCodes.WAIT_COOLDOWN:
      return 'Cooldownoldown pēc close';
    case DecisionCodes.WAIT_MARKET_CLOSED:
      return 'Capital marketStatus nav TRADEABLE/OPEN';
    case DecisionCodes.WAIT_STALE_FEED:
      return 'Capital kotācija atpaliek no fresher refs';
    case DecisionCodes.WAIT_LATE_MOVE:
      return '1m svece jau aizskrējusi trade virzienā';
    case DecisionCodes.WAIT_MANAGE_ONLY:
      return 'Manage-only — lokālais entry brain izslēgts';
    case DecisionCodes.WAIT_TRADING_OFF:
      return 'Trading OFF — tikai lasīšana';
    case DecisionCodes.WAIT_COUNTERTREND:
      return 'Countertrend / with-trend veto';
    case DecisionCodes.WAIT_NO_FADE:
      return 'RANGE/fade/reversal — ieeja aizliegta';
    case DecisionCodes.ERROR_STATE_UNRESOLVED:
      return 'Stāvoklis nav atrisināts — ERROR';
    case DecisionCodes.ERROR_NO_QUOTE:
      return 'Nav Capital quote';
    case DecisionCodes.ERROR_SESSION:
      return 'Capital session kļūda';
    case DecisionCodes.RATE_LIMITED:
      return 'Capital rate limit';
    case DecisionCodes.DUPLICATE_PREVENTED:
      return 'ONE TRADE ONLY — jau ir atvērta pozīcija';
    case DecisionCodes.BROKER_REJECTED:
      return 'Capital noraidīja orderi';
    case DecisionCodes.SIGNAL_CREATED:
      return 'Setup → signal';
    case DecisionCodes.ORDER_SUBMITTING:
      return 'Sūta orderi uz Capital';
    case DecisionCodes.FILLED:
      return 'Fill / pozīcija atvērta';
    default:
      return code;
  }
}
