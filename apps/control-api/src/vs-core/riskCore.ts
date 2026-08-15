/**
 * Risk Core — independent of Strategy.
 * Strategy may propose; Risk alone may accept.
 */

export type RiskRejectCode =
  | 'RISK_REJECTED_TRADING_OFF'
  | 'RISK_REJECTED_MARKET_CLOSED'
  | 'RISK_REJECTED_STALE_FEED'
  | 'RISK_REJECTED_SPREAD'
  | 'RISK_REJECTED_POSITION_EXISTS'
  | 'RISK_REJECTED_DUPLICATE_INTENT'
  | 'RISK_REJECTED_COOLDOWN'
  | 'RISK_REJECTED_SIZE'
  | 'RISK_REJECTED_SESSION_UNHEALTHY'
  | 'RISK_REJECTED_TIME_SYNC'
  | 'RISK_REJECTED_RECONCILE_DIRTY'
  | 'RISK_REJECTED_NO_STOP'
  | 'RISK_REJECTED_MODE_BLOCKS_LIVE'
  | 'RISK_REJECTED_CLIENT_STOPPED'
  | 'RISK_REJECTED_FEED_OFFLINE';

export type RiskDecision =
  | { ok: true; code: 'RISK_ACCEPTED' }
  | { ok: false; code: RiskRejectCode; reason: string };

export type RiskContext = {
  client_id: number;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  /** Client START/STOP — server-side trading permission. */
  client_trading_enabled: boolean;
  market_open: boolean;
  feed_fresh: boolean;
  feed_offline: boolean;
  spread: number | null;
  max_spread: number | null;
  has_open_position: boolean;
  has_duplicate_intent: boolean;
  in_cooldown: boolean;
  session_healthy: boolean;
  time_sync_ok: boolean;
  reconcile_clean: boolean;
  stop_attached: boolean;
  operating_mode: 'UNIT' | 'REPLAY' | 'SIMULATION' | 'DEMO' | 'LIVE';
  /** LIVE money blocked unless operator flag set. */
  live_trading_enabled: boolean;
};

export function evaluateRisk(ctx: RiskContext): RiskDecision {
  if (ctx.operating_mode === 'REPLAY') {
    return {
      ok: false,
      code: 'RISK_REJECTED_MODE_BLOCKS_LIVE',
      reason: 'REPLAY mode never submits broker orders',
    };
  }
  if (ctx.operating_mode === 'LIVE' && !ctx.live_trading_enabled) {
    return {
      ok: false,
      code: 'RISK_REJECTED_MODE_BLOCKS_LIVE',
      reason: 'LIVE trading disabled — operator approval required',
    };
  }
  if (!ctx.client_trading_enabled) {
    return {
      ok: false,
      code: 'RISK_REJECTED_CLIENT_STOPPED',
      reason: 'Client trading STOPPED — new entries blocked',
    };
  }
  if (!ctx.time_sync_ok) {
    return {
      ok: false,
      code: 'RISK_REJECTED_TIME_SYNC',
      reason: 'TIME_SYNC_ERROR — clock drift blocks trading',
    };
  }
  if (!ctx.session_healthy) {
    return {
      ok: false,
      code: 'RISK_REJECTED_SESSION_UNHEALTHY',
      reason: 'Capital session unhealthy',
    };
  }
  if (!ctx.reconcile_clean) {
    return {
      ok: false,
      code: 'RISK_REJECTED_RECONCILE_DIRTY',
      reason: 'POSITION_STATE_MISMATCH — reconcile before entry',
    };
  }
  if (ctx.feed_offline || !ctx.feed_fresh) {
    return {
      ok: false,
      code: ctx.feed_offline ? 'RISK_REJECTED_FEED_OFFLINE' : 'RISK_REJECTED_STALE_FEED',
      reason: ctx.feed_offline ? 'Market feed OFFLINE' : 'Market feed STALE',
    };
  }
  if (!ctx.market_open) {
    return {
      ok: false,
      code: 'RISK_REJECTED_MARKET_CLOSED',
      reason: 'Market not TRADEABLE/OPEN',
    };
  }
  if (ctx.has_open_position) {
    return {
      ok: false,
      code: 'RISK_REJECTED_POSITION_EXISTS',
      reason: 'Open position exists — one trade only',
    };
  }
  if (ctx.has_duplicate_intent) {
    return {
      ok: false,
      code: 'RISK_REJECTED_DUPLICATE_INTENT',
      reason: 'Duplicate intent already in flight',
    };
  }
  if (ctx.in_cooldown) {
    return {
      ok: false,
      code: 'RISK_REJECTED_COOLDOWN',
      reason: 'Entry cooldown active',
    };
  }
  if (!(ctx.size > 0) || !Number.isFinite(ctx.size)) {
    return {
      ok: false,
      code: 'RISK_REJECTED_SIZE',
      reason: `Invalid size ${ctx.size}`,
    };
  }
  if (
    ctx.max_spread != null &&
    ctx.spread != null &&
    Number.isFinite(ctx.spread) &&
    ctx.spread > ctx.max_spread
  ) {
    return {
      ok: false,
      code: 'RISK_REJECTED_SPREAD',
      reason: `Spread ${ctx.spread} > max ${ctx.max_spread}`,
    };
  }
  if (!ctx.stop_attached) {
    return {
      ok: false,
      code: 'RISK_REJECTED_NO_STOP',
      reason: 'Entry without stop-loss is forbidden',
    };
  }
  return { ok: true, code: 'RISK_ACCEPTED' };
}
