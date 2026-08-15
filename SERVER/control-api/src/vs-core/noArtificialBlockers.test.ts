/**
 * Final production call-path audit tests for artificial blockers + technical safety.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRisk } from './riskCore.js';
import { evaluateStrategy } from './strategyCore.js';
import { executeTradeIntent, newDecisionId, newIntentId } from './executionCore.js';
import { OrderStore } from './orderStateMachine.js';
import { DecisionCodes, isNoSetup } from '../services/decisionCodes.js';
import {
  probeStrategyRuntime,
  probeRiskRuntime,
  probeExecutionRuntime,
} from './runtimeHealth.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';

function bar(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: Date.now(), open: o, high: h, low: l, close: c, ticks: 4 };
}

function climbBars() {
  return [
    bar(2400, 2401, 2399.5, 2400.5),
    bar(2400.5, 2402, 2400.2, 2401.5),
    bar(2401.5, 2403, 2401, 2402.8),
  ];
}

function validSetupInput() {
  const bars = climbBars();
  return {
    epic: 'GOLD',
    market_snapshot_id: 's',
    market_open: true,
    feed_fresh: true,
    bar_closed: true,
    closed_bar: bars[2]!,
    bars,
    regime: 'TREND_UP' as const,
    trading_enabled: true,
    minute_candles: [
      { open: 2395, close: 2398 },
      { open: 2398, close: 2401 },
      { open: 2401, close: 2403 },
    ],
  };
}

function baseRisk(over: Record<string, unknown> = {}) {
  return {
    client_id: 1,
    account_id: 1,
    epic: 'GOLD',
    direction: 'BUY' as const,
    size: 0.1,
    client_trading_enabled: true,
    market_open: true,
    feed_fresh: true,
    feed_offline: false,
    spread: 0.2,
    max_spread: 1,
    has_open_position: false,
    has_duplicate_intent: false,
    session_healthy: true,
    time_sync_ok: true,
    reconcile_clean: true,
    stop_attached: true,
    operating_mode: 'DEMO' as const,
    live_trading_enabled: false,
    ...over,
  };
}

describe('ARTIFICIAL_BLOCKERS_REMOVED', () => {
  it('cooldown / daily loss / trade count / consecutive loss / profit target / risk% do NOT block', () => {
    const r = evaluateRisk(
      baseRisk({
        in_cooldown: true,
        daily_loss_pct: 99,
        daily_loss_limit: 1,
        trades_today: 10_000,
        max_trades_per_day: 1,
        consecutive_losses: 50,
        profit_target_hit: true,
        arbitrary_risk_pct: 99,
      })
    );
    expect(r.ok).toBe(true);
  });
});

describe('EXACTLY_ONCE_VALID_SETUP', () => {
  it('valid setup + technical OK → exactly one intent, one execution request, one broker submit', async () => {
    const decision = evaluateStrategy(validSetupInput());
    expect(decision.code === 'ENTER_LONG' || decision.code === 'ENTER_SHORT').toBe(true);
    expect(decision.direction).toBeTruthy();
    expect(String(decision.code)).not.toMatch(/^WAIT_/);
    expect(String(decision.code)).not.toBe('UNKNOWN');

    let submits = 0;
    const store = new OrderStore();
    const r = await executeTradeIntent(
      {
        intent_id: newIntentId(),
        decision_id: decision.decision_id,
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: decision.direction!,
        size: 0.1,
      },
      baseRisk({
        direction: decision.direction!,
        in_cooldown: true,
        daily_loss_pct: -50,
        trades_today: 9999,
        max_trades_per_day: 1,
        consecutive_losses: 20,
        profit_target_hit: true,
        arbitrary_risk_pct: 80,
      }),
      {
        orderStore: store,
        submit: async () => {
          submits += 1;
          return { ok: true, deal_id: 'D1', deal_reference: 'R1', detail: 'ok' };
        },
        reconcile: async () => ({ found: false, detail: 'n/a' }),
      }
    );
    expect(r.ok).toBe(true);
    expect(submits).toBe(1);
    expect(store.openIntents(1, 'GOLD').length).toBe(1);
  });
});

describe('NO_SETUP_THEN_VALID_SETUP', () => {
  it('event1 NO_SETUP → event2 VALID BUY with no cooldown/timer', async () => {
    const e1 = evaluateStrategy({
      ...validSetupInput(),
      bar_closed: false,
      closed_bar: null,
    });
    expect(e1.code).toBe('NO_SETUP');
    expect(isNoSetup(e1.code)).toBe(true);
    expect(String(e1.code)).not.toMatch(/^WAIT_/);

    const e2 = evaluateStrategy(validSetupInput());
    expect(e2.code).toBe('ENTER_LONG');
    expect(e2.direction).toBe('BUY');

    let submits = 0;
    const r = await executeTradeIntent(
      {
        intent_id: newIntentId(),
        decision_id: e2.decision_id,
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: 'BUY',
        size: 0.1,
      },
      baseRisk({ in_cooldown: true }),
      {
        orderStore: new OrderStore(),
        submit: async () => {
          submits += 1;
          return { ok: true, deal_id: 'D2', deal_reference: 'R2', detail: 'ok' };
        },
        reconcile: async () => ({ found: false, detail: 'n/a' }),
      }
    );
    expect(r.ok).toBe(true);
    expect(submits).toBe(1);
  });
});

describe('TECHNICAL_BLOCK_ON_VALID_SETUP', () => {
  it('stale PRIMARY / bad session / duplicate → BLOCKED_TECHNICAL codes (not UNKNOWN)', async () => {
    const decision = evaluateStrategy(validSetupInput());
    expect(decision.direction).toBeTruthy();

    const stale = evaluateRisk(baseRisk({ direction: decision.direction!, feed_fresh: false }));
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('RISK_REJECTED_STALE_FEED');

    const sess = evaluateRisk(baseRisk({ direction: decision.direction!, session_healthy: false }));
    expect(sess.ok).toBe(false);
    expect(sess.code).toBe('RISK_REJECTED_SESSION_UNHEALTHY');

    const dup = evaluateRisk(
      baseRisk({ direction: decision.direction!, has_duplicate_intent: true })
    );
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe('RISK_REJECTED_DUPLICATE_INTENT');

    let submits = 0;
    const blocked = await executeTradeIntent(
      {
        intent_id: newIntentId(),
        decision_id: decision.decision_id,
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: decision.direction!,
        size: 0.1,
      },
      baseRisk({ direction: decision.direction!, feed_fresh: false }),
      {
        orderStore: new OrderStore(),
        submit: async () => {
          submits += 1;
          return { ok: true, deal_id: 'X', deal_reference: 'X', detail: 'ok' };
        },
        reconcile: async () => ({ found: false, detail: 'n/a' }),
      }
    );
    expect(blocked.ok).toBe(false);
    expect(submits).toBe(0);
    expect(String(blocked.code)).not.toBe('UNKNOWN');
    expect(DecisionCodes.BLOCKED_TECHNICAL).toBe('BLOCKED_TECHNICAL');
  });

  it('unresolved previous submit → BROKER_RESULT_UNRESOLVED, no second blind submit', async () => {
    let submits = 0;
    const store = new OrderStore();
    const r = await executeTradeIntent(
      {
        intent_id: newIntentId(),
        decision_id: newDecisionId(),
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: 'BUY',
        size: 0.1,
      },
      baseRisk(),
      {
        orderStore: store,
        submit: async () => {
          submits += 1;
          return { ok: false, timed_out: true, detail: 'timeout' };
        },
        reconcile: async () => ({ found: false, detail: 'not at broker' }),
      }
    );
    expect(submits).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BROKER_RESULT_UNRESOLVED');
    expect(String(r.code)).not.toBe('UNKNOWN');
  });
});

describe('READINESS_RUNTIME_HEALTH', () => {
  it('STRATEGY/RISK/EXECUTION probes require runtime evidence (not module-loaded fake OK)', () => {
    const s = probeStrategyRuntime();
    const r = probeRiskRuntime();
    const e = probeExecutionRuntime(false);
    expect(s.status).toBe('OK');
    expect(s.detail).toMatch(/last_eval=/);
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/operational/);
    expect(e.status).toBe('WARNING'); // broker unknown → not fake OK
    expect(e.reason_code).toBe('BROKER_DEPENDENCY_UNKNOWN');
    const e2 = probeExecutionRuntime(true);
    expect(e2.status).toBe('OK');
  });
});
