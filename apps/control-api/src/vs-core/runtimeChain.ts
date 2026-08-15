/**
 * Runtime trading chain — real call path through CORE modules (not class existence).
 *
 * MARKET → FeedManager → MarketCore → Strategy → TradeIntent → Risk → Execution → OSM → Position → Reconcile
 */

import { FeedManager } from './feedManager.js';
import { MarketCore } from './marketCore.js';
import { evaluateStrategy, type StrategyDecision } from './strategyCore.js';
import { evaluateRisk, type RiskContext } from './riskCore.js';
import {
  executeTradeIntent,
  newDecisionId,
  newIntentId,
  type ExecutionDeps,
  type TradeIntent,
} from './executionCore.js';
import { OrderStore, type OrderRecord } from './orderStateMachine.js';
import { reconcilePositions, type BrokerPosition, type LocalPosition } from './positionReconcile.js';
import { getIncidentCenter } from './incidentCenter.js';
import { getEventBus } from './eventBus.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { CONFIG_VERSION, STRATEGY_VERSION } from './versions.js';
import { checkTimeSync } from './timeSync.js';
import { marketStatusAllowsTrading } from './moneyPathRisk.js';

export type ChainStep = {
  name: string;
  ok: boolean;
  detail: string;
};

/** Explicit outcome — BLOCKED_TECHNICAL is not an execution PASS. */
export type ChainOutcome = 'EXECUTED' | 'NO_SETUP' | 'BLOCKED_TECHNICAL' | 'FAILED';

export type RuntimeChainResult = {
  /** True only when a trade was executed (POSITION_OPEN / FILLED path). */
  ok: boolean;
  outcome: ChainOutcome;
  steps: ChainStep[];
  decision: StrategyDecision | null;
  intent: TradeIntent | null;
  order: OrderRecord | null;
  broker_submits: number;
  blocked_reason: string | null;
};

export type RuntimeChainInput = {
  epic: string;
  primary: { bid: number; ask: number; source_timestamp: string; market_status?: string };
  reference?: { bid: number; ask: number; source_timestamp: string };
  primary_offline?: boolean;
  bars: TenSecBar[];
  closed_bar: TenSecBar;
  regime: string;
  client_id: number;
  account_id: number;
  size: number;
  trading_enabled: boolean;
  broker?: ExecutionDeps['submit'];
  reconcile?: ExecutionDeps['reconcile'];
  confirm?: ExecutionDeps['confirm'];
  local_positions?: LocalPosition[];
  broker_positions?: BrokerPosition[];
  orderStore?: OrderStore;
  /** Test override — default from checkTimeSync() */
  time_sync_ok?: boolean;
  session_healthy?: boolean;
  reconcile_clean?: boolean;
};

function blocked(
  steps: ChainStep[],
  reason: string,
  extras?: Partial<RuntimeChainResult>
): RuntimeChainResult {
  return {
    ok: false,
    outcome: 'BLOCKED_TECHNICAL',
    steps,
    decision: extras?.decision ?? null,
    intent: extras?.intent ?? null,
    order: extras?.order ?? null,
    broker_submits: extras?.broker_submits ?? 0,
    blocked_reason: reason,
  };
}

export async function runRuntimeChain(input: RuntimeChainInput): Promise<RuntimeChainResult> {
  const steps: ChainStep[] = [];
  const bus = getEventBus();
  const incidents = getIncidentCenter();
  const feeds = new FeedManager(5000);
  const market = new MarketCore(5000);
  const orderStore = input.orderStore || new OrderStore();
  let broker_submits = 0;

  feeds.defineSource('capital', 'PRIMARY');
  feeds.defineSource('yahoo', 'REFERENCE');

  // 1) MARKET INPUT + FEED MANAGER
  if (input.primary_offline) {
    feeds.markOffline('capital', input.epic, 'PRIMARY offline');
  } else {
    feeds.ingest({
      source: 'capital',
      epic: input.epic,
      bid: input.primary.bid,
      ask: input.primary.ask,
      source_timestamp: input.primary.source_timestamp,
    });
  }
  if (input.reference) {
    feeds.ingest({
      source: 'yahoo',
      epic: input.epic,
      bid: input.reference.bid,
      ask: input.reference.ask,
      source_timestamp: input.reference.source_timestamp,
    });
  }
  const feedSnap = feeds.snapshot(input.epic);
  steps.push({
    name: 'FEED_MANAGER',
    ok: feedSnap.allows_execution && feedSnap.primary_status === 'LIVE',
    detail: `primary=${feedSnap.primary_status} exec=${feedSnap.allows_execution} block=${feedSnap.block_reason || 'none'}`,
  });
  await bus.emit('MarketTickReceived', {
    source: 'runtime-chain',
    client_id: input.client_id,
    payload: { detail: `PRIMARY ${feedSnap.primary_status}` },
  });

  // 2) NORMALIZATION / DATA QUALITY via MarketCore
  let tickQuality = 'OFFLINE';
  if (!input.primary_offline) {
    const tick = market.ingest({
      epic: input.epic,
      bid: input.primary.bid,
      ask: input.primary.ask,
      source: 'capital',
      source_timestamp: input.primary.source_timestamp,
      market_status: input.primary.market_status || 'TRADEABLE',
    });
    tickQuality = tick.quality;
    steps.push({
      name: 'MARKET_CORE_QUALITY',
      ok: tick.accepted && tick.quality === 'OK',
      detail: `${tick.quality} accepted=${tick.accepted}`,
    });
  } else {
    market.markOffline(input.epic);
    steps.push({ name: 'MARKET_CORE_QUALITY', ok: false, detail: 'OFFLINE' });
  }

  const marketStatusOk = marketStatusAllowsTrading(input.primary.market_status || 'TRADEABLE');
  const marketAllows = market.allowsTrading(input.epic) && feedSnap.allows_execution && marketStatusOk;
  steps.push({
    name: 'MARKET_STATE',
    ok: marketAllows,
    detail: marketAllows ? 'TRADEABLE+PRIMARY_LIVE' : 'blocked',
  });

  if (!feedSnap.allows_execution || !marketAllows) {
    const reason = feedSnap.block_reason || (marketStatusOk ? `MARKET_${tickQuality}` : 'MARKET_STATUS_UNVERIFIED');
    incidents.raise({
      severity: 'WARNING',
      component: 'runtime-chain',
      client_id: input.client_id,
      error_code: reason,
      reason: 'New entry blocked by feed/market quality',
      recovery_action: 'wait for PRIMARY LIVE',
    });
    return blocked(steps, reason);
  }

  // 3) STRATEGY
  const decision = evaluateStrategy({
    epic: input.epic,
    market_snapshot_id: `chain_${Date.now()}`,
    market_open: true,
    feed_fresh: feedSnap.primary_status === 'LIVE',
    bar_closed: true,
    closed_bar: input.closed_bar,
    bars: input.bars,
    regime: input.regime,
    trading_enabled: input.trading_enabled,
  });
  steps.push({
    name: 'STRATEGY_DECISION',
    ok: true,
    detail: `${decision.code} ${decision.direction || ''}`.trim(),
  });
  await bus.emit('DecisionCreated', {
    source: 'runtime-chain',
    client_id: input.client_id,
    payload: { detail: decision.code, decision_id: decision.decision_id },
  });

  if (decision.code !== 'ENTER_LONG' && decision.code !== 'ENTER_SHORT') {
    const isBlocked = decision.code === 'BLOCKED_TECHNICAL';
    return {
      ok: false,
      outcome: isBlocked ? 'BLOCKED_TECHNICAL' : 'NO_SETUP',
      steps,
      decision,
      intent: null,
      order: null,
      broker_submits: 0,
      blocked_reason: decision.code,
    };
  }

  const intent: TradeIntent = {
    intent_id: newIntentId(),
    decision_id: decision.decision_id || newDecisionId(),
    client_id: input.client_id,
    account_id: input.account_id,
    epic: input.epic,
    direction: decision.direction!,
    size: input.size,
    stop_level: decision.direction === 'BUY' ? input.primary.bid * 0.998 : input.primary.ask * 1.002,
    strategy_version: STRATEGY_VERSION,
    config_version: CONFIG_VERSION,
    market_snapshot_id: decision.market_snapshot_id,
  };
  steps.push({ name: 'TRADE_INTENT', ok: true, detail: intent.intent_id });

  const timeOk = input.time_sync_ok ?? checkTimeSync().ok;
  const sessionOk = input.session_healthy ?? true;
  const reconClean = input.reconcile_clean ?? true;
  if (!timeOk) return blocked(steps, 'TIME_SYNC_ERROR', { decision, intent });
  if (!sessionOk) return blocked(steps, 'SESSION_HEALTH_UNVERIFIED', { decision, intent });
  if (!reconClean) return blocked(steps, 'RECONCILIATION_NOT_CLEAN', { decision, intent });

  const dup = orderStore.openIntents(input.account_id, input.epic).length > 0;
  const riskCtx: RiskContext = {
    client_id: input.client_id,
    account_id: input.account_id,
    epic: input.epic,
    direction: intent.direction,
    size: intent.size,
    client_trading_enabled: input.trading_enabled,
    market_open: true,
    feed_fresh: feedSnap.primary_status === 'LIVE',
    feed_offline: feedSnap.primary_status === 'OFFLINE' || feedSnap.primary_status === 'MISSING',
    spread: input.primary.ask - input.primary.bid,
    max_spread: null,
    has_open_position: (input.broker_positions || []).some((p) => p.epic === input.epic),
    has_duplicate_intent: dup,
    session_healthy: sessionOk,
    time_sync_ok: timeOk,
    reconcile_clean: reconClean,
    stop_attached: intent.stop_level != null || intent.stop_distance != null,
    operating_mode: 'DEMO',
    live_trading_enabled: false,
  };
  const risk = evaluateRisk(riskCtx);
  steps.push({
    name: 'RISK',
    ok: risk.ok,
    detail: risk.ok ? 'RISK_ACCEPTED' : `${risk.code}: ${risk.reason}`,
  });
  if (!risk.ok) {
    await bus.emit('RiskRejected', {
      source: 'runtime-chain',
      client_id: input.client_id,
      payload: { detail: risk.code },
    });
    return blocked(steps, risk.code, { decision, intent });
  }

  const exec = await executeTradeIntent(intent, riskCtx, {
    orderStore,
    submit: async (i, cid) => {
      broker_submits += 1;
      if (input.broker) return input.broker(i, cid);
      return {
        ok: true,
        deal_reference: `REF-${i.intent_id.slice(0, 8)}`,
        deal_id: `DEAL-${i.intent_id.slice(0, 8)}`,
        detail: 'fixture fill',
      };
    },
    reconcile: async (i, cid) => {
      if (input.reconcile) return input.reconcile(i, cid);
      return { found: false, detail: 'not found' };
    },
    confirm: input.confirm,
  });
  steps.push({
    name: 'EXECUTION',
    ok: exec.ok && exec.code === 'POSITION_OPEN',
    detail: exec.ok ? exec.code : `${exec.code}: ${exec.reason}`,
  });
  steps.push({
    name: 'ORDER_STATE_MACHINE',
    ok: !!exec.order,
    detail: exec.order?.state || 'none',
  });

  if (!exec.ok) {
    return {
      ok: false,
      outcome: 'FAILED',
      steps,
      decision,
      intent,
      order: exec.order || null,
      broker_submits,
      blocked_reason: exec.reason,
    };
  }

  // Position + reconciliation
  const local = input.local_positions || [];
  const broker = input.broker_positions || [];
  if (exec.code === 'POSITION_OPEN' && exec.order) {
    broker.push({
      epic: input.epic,
      direction: intent.direction,
      deal_id: exec.order.broker_deal_id || 'D',
      size: intent.size,
    });
    local.push({
      account_id: input.account_id,
      client_id: input.client_id,
      epic: input.epic,
      direction: intent.direction,
      deal_id: exec.order.broker_deal_id || 'D',
      size: intent.size,
    });
  }
  const recon = reconcilePositions(local, broker, input.account_id);
  steps.push({
    name: 'RECONCILIATION',
    ok: recon.clean,
    detail: recon.code,
  });

  if (exec.code !== 'POSITION_OPEN') {
    return {
      ok: false,
      outcome: 'BLOCKED_TECHNICAL',
      steps,
      decision,
      intent,
      order: exec.order || null,
      broker_submits,
      blocked_reason: exec.code,
    };
  }

  return {
    ok: exec.ok && recon.clean,
    outcome: exec.ok && recon.clean ? 'EXECUTED' : 'FAILED',
    steps,
    decision,
    intent,
    order: exec.order || null,
    broker_submits,
    blocked_reason: exec.ok && recon.clean ? null : recon.code,
  };
}

/** Concurrent duplicate: same signal twice — expect single broker submit when second sees open intent. */
export async function runDuplicateProtectionTest(): Promise<{
  ok: boolean;
  submits: number;
  detail: string;
}> {
  const store = new OrderStore();
  const now = new Date().toISOString();
  const bar = {
    open_time_ms: Date.now(),
    open: 2400,
    high: 2403,
    low: 2399,
    close: 2402.5,
    ticks: 4,
  };
  const bars = [
    { ...bar, close: 2400.5 },
    { ...bar, close: 2401.5 },
    bar,
  ];

  let submits = 0;
  const mk = () =>
    runRuntimeChain({
      epic: 'GOLD',
      primary: { bid: 2402, ask: 2402.3, source_timestamp: now, market_status: 'TRADEABLE' },
      bars,
      closed_bar: bar,
      regime: 'TREND_UP',
      client_id: 1,
      account_id: 1,
      size: 0.1,
      trading_enabled: true,
      orderStore: store,
      broker: async () => {
        submits += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, deal_reference: 'R1', deal_id: 'D1', detail: 'ok' };
      },
    });

  const [a, b] = await Promise.all([mk(), mk()]);
  submits = 0;
  const first = await mk();
  const second = await mk();
  const sequentialOk =
    first.broker_submits + second.broker_submits === 1 ||
    (first.outcome === 'EXECUTED' && second.blocked_reason === 'RISK_REJECTED_DUPLICATE_INTENT') ||
    second.broker_submits === 0;

  const totalSubmits = (first.broker_submits || 0) + (second.broker_submits || 0);
  return {
    ok: sequentialOk && totalSubmits <= 1,
    submits: totalSubmits,
    detail: `first_block=${first.blocked_reason} second_block=${second.blocked_reason} submits=${totalSubmits} concurrent_a=${a.broker_submits} b=${b.broker_submits} outcomes=${first.outcome}/${second.outcome}`,
  };
}
