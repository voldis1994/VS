/**
 * Runtime health probes for STRATEGY / RISK / EXECUTION.
 * "Module imported" is NOT enough — must exercise the live call path.
 */

import { evaluateStrategy } from './strategyCore.js';
import { evaluateRisk } from './riskCore.js';
import {
  OrderStore,
  canTransition,
  createOrderRecord,
  transitionOrder,
} from './orderStateMachine.js';
import { probe, type ProbeResult } from './readiness.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';

function bar(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: 1_700_000_000_000, open: o, high: h, low: l, close: c, ticks: 4 };
}

/** STRATEGY: loaded + initialized + last evaluation healthy (deterministic codes only). */
export function probeStrategyRuntime(): ProbeResult {
  try {
    const closed = bar(2400, 2401, 2399, 2400.5);
    const d = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 'health',
      market_open: true,
      feed_fresh: true,
      bar_closed: false,
      closed_bar: null,
      bars: [closed],
      regime: 'TREND_UP',
      trading_enabled: true,
    });
    if (String(d.code) === 'UNKNOWN') {
      return probe('STRATEGY', 'CRITICAL', 'Strategy returned UNKNOWN', 'STRATEGY_UNKNOWN_DECISION');
    }
    if (d.code !== 'NO_SETUP' && d.code !== 'ENTER_LONG' && d.code !== 'ENTER_SHORT' && d.code !== 'BLOCKED_TECHNICAL') {
      return probe(
        'STRATEGY',
        'ERROR',
        `Unexpected decision code ${d.code}`,
        'STRATEGY_UNHEALTHY_CODE'
      );
    }
    if (!d.decision_id || !d.strategy_version) {
      return probe('STRATEGY', 'ERROR', 'Missing decision_id/strategy_version', 'STRATEGY_NOT_INITIALIZED');
    }
    return probe(
      'STRATEGY',
      'OK',
      `initialized · last_eval=${d.code} · decision_id=${d.decision_id.slice(0, 8)}`
    );
  } catch (e) {
    return probe(
      'STRATEGY',
      'CRITICAL',
      e instanceof Error ? e.message : String(e),
      'STRATEGY_EVAL_FAILED'
    );
  }
}

/** RISK: initialized + validation path operational. */
export function probeRiskRuntime(): ProbeResult {
  try {
    const accept = evaluateRisk({
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      client_trading_enabled: true,
      market_open: true,
      feed_fresh: true,
      feed_offline: false,
      spread: 0.1,
      max_spread: 1,
      has_open_position: false,
      has_duplicate_intent: false,
      session_healthy: true,
      time_sync_ok: true,
      reconcile_clean: true,
      stop_attached: true,
      operating_mode: 'DEMO',
      live_trading_enabled: false,
      // Artificial fields must be ignored
      in_cooldown: true,
      daily_loss_pct: 99,
      trades_today: 999,
    });
    const rejectDup = evaluateRisk({
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      client_trading_enabled: true,
      market_open: true,
      feed_fresh: true,
      feed_offline: false,
      spread: 0.1,
      max_spread: 1,
      has_open_position: false,
      has_duplicate_intent: true,
      session_healthy: true,
      time_sync_ok: true,
      reconcile_clean: true,
      stop_attached: true,
      operating_mode: 'DEMO',
      live_trading_enabled: false,
    });
    if (!accept.ok) {
      return probe('RISK', 'CRITICAL', `Accept path failed: ${accept.code}`, 'RISK_ACCEPT_PATH_BROKEN');
    }
    if (rejectDup.ok || rejectDup.code !== 'RISK_REJECTED_DUPLICATE_INTENT') {
      return probe('RISK', 'CRITICAL', 'Duplicate gate not operational', 'RISK_DUP_GATE_BROKEN');
    }
    return probe('RISK', 'OK', 'initialized · accept+duplicate validation operational');
  } catch (e) {
    return probe('RISK', 'CRITICAL', e instanceof Error ? e.message : String(e), 'RISK_EVAL_FAILED');
  }
}

/** EXECUTION: OSM operational + broker dependency state known (not assumed OK). */
export function probeExecutionRuntime(brokerKnown: boolean = false): ProbeResult {
  try {
    const store = new OrderStore();
    let o = createOrderRecord({
      intent_id: 'health',
      client_order_id: 'health_co',
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      strategy_version: 'health',
      config_version: '1',
      decision_id: 'd',
    });
    store.put(o);
    if (!canTransition('SIGNAL_CREATED', 'RISK_ACCEPTED')) {
      return probe('EXECUTION', 'CRITICAL', 'OSM transition broken', 'OSM_BROKEN');
    }
    o = transitionOrder(o, 'RISK_ACCEPTED');
    o = transitionOrder(o, 'ORDER_CREATED');
    o = transitionOrder(o, 'SUBMITTING');
    store.put(o);
    if (!brokerKnown) {
      return probe(
        'EXECUTION',
        'WARNING',
        'OSM operational · broker dependency state unknown',
        'BROKER_DEPENDENCY_UNKNOWN'
      );
    }
    return probe('EXECUTION', 'OK', 'OSM operational · broker dependency known');
  } catch (e) {
    return probe(
      'EXECUTION',
      'CRITICAL',
      e instanceof Error ? e.message : String(e),
      'EXECUTION_HEALTH_FAILED'
    );
  }
}

export function defaultCoreRuntimeProbes(opts?: {
  brokerKnown?: boolean;
}): ProbeResult[] {
  return [
    probeStrategyRuntime(),
    probeRiskRuntime(),
    probeExecutionRuntime(opts?.brokerKnown === true),
  ];
}
