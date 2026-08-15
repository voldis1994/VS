/**
 * Risk / Safety Core — technical validation only.
 *
 * Strategy decides WHETHER there is a trade (setup → intent).
 * This module only decides WHETHER that intent may be safely executed.
 *
 * FORBIDDEN here (artificial trading strategy — must never block a valid setup):
 *   daily loss %, daily loss limit, max trades/day, trade count limits,
 *   artificial cooldown, consecutive-loss blocker, profit target blocker,
 *   arbitrary risk %, arbitrary confidence threshold.
 *
 * REQUIRED technical blocks:
 *   duplicate intent/order, invalid lot, unauthorized client/market,
 *   stale/offline PRIMARY feed, bad session, reconcile conflict,
 *   missing stop, unresolved prior submit (caller), DB/mode gates.
 */

export type RiskRejectCode =
  | 'RISK_REJECTED_TRADING_OFF'
  | 'RISK_REJECTED_MARKET_CLOSED'
  | 'RISK_REJECTED_STALE_FEED'
  | 'RISK_REJECTED_SPREAD'
  | 'RISK_REJECTED_POSITION_EXISTS'
  | 'RISK_REJECTED_DUPLICATE_INTENT'
  | 'RISK_REJECTED_SIZE'
  | 'RISK_REJECTED_SESSION_UNHEALTHY'
  | 'RISK_REJECTED_TIME_SYNC'
  | 'RISK_REJECTED_RECONCILE_DIRTY'
  | 'RISK_REJECTED_NO_STOP'
  | 'RISK_REJECTED_MODE_BLOCKS_LIVE'
  | 'RISK_REJECTED_CLIENT_STOPPED'
  | 'RISK_REJECTED_FEED_OFFLINE'
  | 'RISK_REJECTED_UNAUTHORIZED_MARKET'
  | 'RISK_REJECTED_LOT_OUT_OF_RANGE';

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
  /** Broker/account max spread when provided — technical, not strategy. */
  max_spread: number | null;
  has_open_position: boolean;
  has_duplicate_intent: boolean;
  session_healthy: boolean;
  time_sync_ok: boolean;
  reconcile_clean: boolean;
  stop_attached: boolean;
  operating_mode: 'UNIT' | 'REPLAY' | 'SIMULATION' | 'DEMO' | 'LIVE';
  /** LIVE money blocked unless operator flag set. */
  live_trading_enabled: boolean;
  /** Optional broker lot bounds — technical. */
  min_lot?: number | null;
  max_lot?: number | null;
  /** Optional allow-list — technical unauthorized market. */
  allowed_epics?: string[] | null;
  /**
   * @deprecated Ignored. Artificial cooldown must never block execution.
   * Kept optional so old callers compile; value has no effect.
   */
  in_cooldown?: boolean;
  /** Ignored — not a technical gate. */
  daily_loss_pct?: number | null;
  daily_loss_limit?: number | null;
  trades_today?: number | null;
  max_trades_per_day?: number | null;
  consecutive_losses?: number | null;
  profit_target_hit?: boolean;
  arbitrary_risk_pct?: number | null;
};

export function evaluateRisk(ctx: RiskContext): RiskDecision {
  // Explicitly ignore artificial strategy-like fields (documented no-ops).
  void ctx.in_cooldown;
  void ctx.daily_loss_pct;
  void ctx.daily_loss_limit;
  void ctx.trades_today;
  void ctx.max_trades_per_day;
  void ctx.consecutive_losses;
  void ctx.profit_target_hit;
  void ctx.arbitrary_risk_pct;

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
  if (ctx.allowed_epics && ctx.allowed_epics.length > 0 && !ctx.allowed_epics.includes(ctx.epic)) {
    return {
      ok: false,
      code: 'RISK_REJECTED_UNAUTHORIZED_MARKET',
      reason: `Epic ${ctx.epic} not authorized for this account`,
    };
  }
  if (ctx.has_open_position) {
    return {
      ok: false,
      code: 'RISK_REJECTED_POSITION_EXISTS',
      reason: 'Open position exists — duplicate entry blocked',
    };
  }
  if (ctx.has_duplicate_intent) {
    return {
      ok: false,
      code: 'RISK_REJECTED_DUPLICATE_INTENT',
      reason: 'Duplicate intent already in flight',
    };
  }
  if (!(ctx.size > 0) || !Number.isFinite(ctx.size)) {
    return {
      ok: false,
      code: 'RISK_REJECTED_SIZE',
      reason: `Invalid size ${ctx.size}`,
    };
  }
  if (ctx.min_lot != null && ctx.size < ctx.min_lot) {
    return {
      ok: false,
      code: 'RISK_REJECTED_LOT_OUT_OF_RANGE',
      reason: `Lot ${ctx.size} < min ${ctx.min_lot}`,
    };
  }
  if (ctx.max_lot != null && ctx.size > ctx.max_lot) {
    return {
      ok: false,
      code: 'RISK_REJECTED_LOT_OUT_OF_RANGE',
      reason: `Lot ${ctx.size} > max ${ctx.max_lot}`,
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
