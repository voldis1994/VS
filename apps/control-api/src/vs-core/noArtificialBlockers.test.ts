/**
 * CRITICAL: artificial trading blockers must never suppress a valid strategy setup.
 * Technical safety blockers must still fire.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRisk } from './riskCore.js';
import { evaluateStrategy } from './strategyCore.js';
import { executeTradeIntent, newDecisionId, newIntentId } from './executionCore.js';
import { OrderStore } from './orderStateMachine.js';
import { DecisionCodes, isNoSetup, isTechnicalBlock } from '../services/decisionCodes.js';
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
    expect(r.code).toBe('RISK_ACCEPTED');
  });

  it('strategy ignores in_cooldown and still emits ENTER on valid setup', () => {
    const bars = climbBars();
    const d = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 's1',
      market_open: true,
      feed_fresh: true,
      bar_closed: true,
      closed_bar: bars[2]!,
      bars,
      regime: 'TREND_UP',
      trading_enabled: true,
      in_cooldown: true,
      minute_candles: [
        { open: 2395, close: 2398 },
        { open: 2398, close: 2401 },
        { open: 2401, close: 2403 },
      ],
    });
    expect(d.code).toBe('ENTER_LONG');
    expect(d.direction).toBe('BUY');
  });

  it('NO_SETUP is not WAIT mode and not UNKNOWN', () => {
    const d = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 's2',
      market_open: true,
      feed_fresh: true,
      bar_closed: false,
      closed_bar: null,
      bars: climbBars(),
      regime: 'TREND_UP',
      trading_enabled: true,
    });
    expect(d.code).toBe('NO_SETUP');
    expect(d.direction).toBeNull();
    expect(String(d.code)).not.toBe('UNKNOWN');
    expect(String(d.code)).not.toMatch(/^WAIT_/);
    expect(isNoSetup(DecisionCodes.NO_SETUP)).toBe(true);
  });
});

describe('VALID_SETUP_ONE_EXECUTION', () => {
  it('valid setup + technical OK → exactly one broker submit', async () => {
    const bars = climbBars();
    const decision = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 'live',
      market_open: true,
      feed_fresh: true,
      bar_closed: true,
      closed_bar: bars[2]!,
      bars,
      regime: 'TREND_UP',
      trading_enabled: true,
      // Artificial fields present — must not suppress
      in_cooldown: true,
      minute_candles: [
        { open: 2395, close: 2398 },
        { open: 2398, close: 2401 },
        { open: 2401, close: 2403 },
      ],
    });
    expect(decision.code === 'ENTER_LONG' || decision.code === 'ENTER_SHORT').toBe(true);
    expect(decision.direction).toBeTruthy();

    let submits = 0;
    const store = new OrderStore();
    const r = await executeTradeIntent(
      {
        intent_id: newIntentId(),
        decision_id: decision.decision_id || newDecisionId(),
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: decision.direction!,
        size: 0.1,
      },
      baseRisk({
        direction: decision.direction!,
        in_cooldown: true,
        daily_loss_pct: 50,
        trades_today: 999,
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
  });
});

describe('TECHNICAL_SAFETY_STILL_BLOCKS', () => {
  it('duplicate / invalid lot / stale feed / bad session / dirty reconcile blocked', () => {
    expect(evaluateRisk(baseRisk({ has_duplicate_intent: true })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ has_open_position: true })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ size: -1 })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ size: 0 })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ min_lot: 0.5, size: 0.1 })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ feed_fresh: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ feed_offline: true })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ session_healthy: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ reconcile_clean: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ stop_attached: false })).ok).toBe(false);
    expect(
      evaluateRisk(baseRisk({ allowed_epics: ['SILVER'], epic: 'GOLD' })).code
    ).toBe('RISK_REJECTED_UNAUTHORIZED_MARKET');
    expect(isTechnicalBlock(DecisionCodes.BLOCKED_TECHNICAL)).toBe(true);
  });

  it('unresolved prior submit does not blind-retry (timeout → reconcile only)', async () => {
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
      baseRisk({ in_cooldown: true, trades_today: 999 }),
      {
        orderStore: store,
        submit: async () => {
          submits += 1;
          return { ok: false, timed_out: true, detail: 'timeout' };
        },
        reconcile: async () => ({
          found: true,
          deal_id: 'DX',
          deal_reference: 'RX',
          detail: 'found',
        }),
      }
    );
    expect(submits).toBe(1);
    expect(r.ok).toBe(true);
  });
});
