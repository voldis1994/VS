/**
 * Build authoritative RiskContext for the production money path.
 * FAIL CLOSED when critical state cannot be determined — never invent healthy=true.
 */

import type { RiskContext } from './riskCore.js';
import type { FeedManager } from './feedManager.js';
import { checkTimeSync } from './timeSync.js';
import type { DurableOrderStore } from './durableOrderStore.js';
import type { CapitalMarketQuote } from '../services/capitalCom.js';

export type MoneyPathRiskInput = {
  client_id: number;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  client_trading_enabled: boolean;
  quote: CapitalMarketQuote;
  feedManager: FeedManager;
  orderStore: DurableOrderStore;
  /** From CapitalSessionManager.isTradingAllowed or equivalent */
  session_healthy: boolean | null;
  /** From last successful position reconcile this cycle */
  reconcile_clean: boolean | null;
  /** Broker listed open on this epic */
  has_open_position: boolean | null;
  stop_attached: boolean;
  operating_mode: RiskContext['operating_mode'];
  live_trading_enabled: boolean;
  min_lot?: number | null;
  max_lot?: number | null;
  /** Broker instrument max spread when known; null = no artificial limit */
  max_spread?: number | null;
  allowed_epics?: string[] | null;
};

export type MoneyPathRiskBuild =
  | { ok: true; ctx: RiskContext }
  | { ok: false; code: string; reason: string };

export function marketStatusAllowsTrading(status: string | null | undefined): boolean {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  // FAIL CLOSED — unknown/empty is not tradeable
  if (!s) return false;
  return s === 'TRADEABLE' || s === 'OPEN';
}

export function buildMoneyPathRisk(input: MoneyPathRiskInput): MoneyPathRiskBuild {
  const feed = input.feedManager.snapshot(input.epic);
  if (feed.primary_status === 'MISSING' || feed.primary_status === 'OFFLINE') {
    return {
      ok: false,
      code: 'RISK_REJECTED_FEED_OFFLINE',
      reason: feed.block_reason || 'PRIMARY_FEED_OFFLINE',
    };
  }
  if (feed.primary_status === 'ERROR') {
    return {
      ok: false,
      code: 'RISK_REJECTED_FEED_OFFLINE',
      reason: feed.block_reason || 'PRIMARY_FEED_ERROR',
    };
  }
  if (feed.primary_status === 'STALE' || !feed.allows_execution) {
    return {
      ok: false,
      code: 'RISK_REJECTED_STALE_FEED',
      reason: feed.block_reason || 'PRIMARY_FEED_STALE',
    };
  }

  if (input.session_healthy == null) {
    return {
      ok: false,
      code: 'RISK_REJECTED_SESSION_UNHEALTHY',
      reason: 'SESSION_HEALTH_UNVERIFIED',
    };
  }
  if (input.reconcile_clean == null) {
    return {
      ok: false,
      code: 'RISK_REJECTED_RECONCILE_DIRTY',
      reason: 'RECONCILIATION_NOT_CLEAN',
    };
  }
  if (input.has_open_position == null) {
    return {
      ok: false,
      code: 'RISK_REJECTED_RECONCILE_DIRTY',
      reason: 'POSITION_STATE_UNVERIFIED',
    };
  }

  const time = checkTimeSync();
  if (!time.ok) {
    return {
      ok: false,
      code: 'RISK_REJECTED_TIME_SYNC',
      reason: time.detail || 'TIME_SYNC_ERROR',
    };
  }

  if (!marketStatusAllowsTrading(input.quote.market_status)) {
    return {
      ok: false,
      code: 'RISK_REJECTED_MARKET_CLOSED',
      reason: input.quote.market_status
        ? `MARKET_STATUS_${String(input.quote.market_status).toUpperCase()}`
        : 'MARKET_STATUS_UNVERIFIED',
    };
  }

  const dupIntent =
    input.orderStore.openIntents(input.account_id, input.epic).length > 0 ||
    input.orderStore.hasUnresolvedSubmission(input.account_id, input.epic);

  const ctx: RiskContext = {
    client_id: input.client_id,
    account_id: input.account_id,
    epic: input.epic,
    direction: input.direction,
    size: input.size,
    client_trading_enabled: input.client_trading_enabled,
    market_open: true,
    feed_fresh: feed.primary_status === 'LIVE',
    // OFFLINE/MISSING/ERROR already returned above — surviving path is never offline.
    feed_offline: false,
    spread: input.quote.spread ?? null,
    max_spread: input.max_spread ?? null,
    has_open_position: input.has_open_position,
    has_duplicate_intent: dupIntent,
    session_healthy: input.session_healthy,
    time_sync_ok: true,
    reconcile_clean: input.reconcile_clean,
    stop_attached: input.stop_attached,
    operating_mode: input.operating_mode,
    live_trading_enabled: input.live_trading_enabled,
    min_lot: input.min_lot,
    max_lot: input.max_lot,
    allowed_epics: input.allowed_epics,
  };
  return { ok: true, ctx };
}
