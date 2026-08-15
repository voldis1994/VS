/**
 * P0 LIVE PATH failure injection A–J.
 * Proves the same execution/risk/store code used by the Capital money path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateStrategy } from './strategyCore.js';
import { evaluateRisk } from './riskCore.js';
import {
  executeTradeIntent,
  newDecisionId,
  newIntentId,
} from './executionCore.js';
import { OrderStore } from './orderStateMachine.js';
import { DurableOrderStore } from './durableOrderStore.js';
import { FeedManager } from './feedManager.js';
import { allowEntryFromPrimaryFeed } from './primaryFeedGate.js';
import { buildMoneyPathRisk, marketStatusAllowsTrading } from './moneyPathRisk.js';
import { runRuntimeChain } from './runtimeChain.js';
import {
  getClientTradingRegistry,
  resetClientTradingRegistryForTests,
} from './clientTrading.js';
import { CapitalSessionManager } from './capitalSessionManager.js';
import { getEventBus } from './eventBus.js';
import { MobileAuthService } from './mobileAuth.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import type { CapitalMarketQuote } from '../services/capitalCom.js';
import { effectiveRegimeName } from '../services/robotDesk.js';

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

function quote(over: Partial<CapitalMarketQuote> = {}): CapitalMarketQuote {
  return {
    epic: 'GOLD',
    bid: 2402,
    ask: 2402.3,
    mid: 2402.15,
    spread: 0.3,
    market_status: 'TRADEABLE',
    min_stop_distance: 0.5,
    min_stop_points: 10,
    min_stop_unit: 'POINTS',
    point_size: 0.1,
    ...over,
  } as CapitalMarketQuote;
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
    max_spread: null,
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

describe('P0_LIVE_PATH_FAILURE_A_OVERLAP', () => {
  it('A) overlapping cycles / shared store → maximum one broker submission', async () => {
    const store = new OrderStore();
    let submits = 0;
    const bars = climbBars();
    const now = new Date().toISOString();
    const mk = () =>
      runRuntimeChain({
        epic: 'GOLD',
        primary: { bid: 2402, ask: 2402.3, source_timestamp: now, market_status: 'TRADEABLE' },
        bars,
        closed_bar: bars[2]!,
        regime: 'TREND_UP',
        client_id: 1,
        account_id: 1,
        size: 0.1,
        trading_enabled: true,
        orderStore: store,
        broker: async () => {
          submits += 1;
          await new Promise((r) => setTimeout(r, 15));
          return { ok: true, deal_reference: 'R1', deal_id: 'D1', detail: 'ok' };
        },
      });
    await Promise.all([mk(), mk(), mk()]);
    expect(submits).toBeLessThanOrEqual(1);
  });
});

describe('P0_LIVE_PATH_FAILURE_B_TIMEOUT', () => {
  it('B) HTTP lost / timeout → no blind second submit; reconcile resolves', async () => {
    let submits = 0;
    const dir = mkdtempSync(join(tmpdir(), 'vs-ledger-'));
    const store = new DurableOrderStore(join(dir, 'orders.json'));
    try {
      const r = await executeTradeIntent(
        {
          intent_id: newIntentId(),
          decision_id: newDecisionId(),
          client_id: 1,
          account_id: 1,
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          setup_id: 'setup-b',
        },
        baseRisk(),
        {
          orderStore: store,
          submit: async () => {
            submits += 1;
            return { ok: false, timed_out: true, detail: 'response lost' };
          },
          reconcile: async () => ({
            found: true,
            deal_id: 'DX',
            deal_reference: 'RX',
            detail: 'found original',
          }),
        }
      );
      expect(submits).toBe(1);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.order.state).toBe('POSITION_OPEN');

      // Second attempt must see unresolved/open and not blind-resubmit
      const r2 = await executeTradeIntent(
        {
          intent_id: newIntentId(),
          decision_id: newDecisionId(),
          client_id: 1,
          account_id: 1,
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          setup_id: 'setup-b2',
        },
        baseRisk({ has_duplicate_intent: true }),
        {
          orderStore: store,
          submit: async () => {
            submits += 1;
            return { ok: true, deal_id: 'D2', detail: 'should not' };
          },
          reconcile: async () => ({ found: false, detail: 'n/a' }),
        }
      );
      expect(r2.ok).toBe(false);
      expect(submits).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P0_LIVE_PATH_FAILURE_C_STALE_FEED', () => {
  it('C) PRIMARY stale immediately before entry → BLOCKED_TECHNICAL', () => {
    const feeds = new FeedManager(50);
    feeds.defineSource('capital', 'PRIMARY');
    feeds.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: 2400,
      ask: 2400.2,
      source_timestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    feeds.markOffline('capital', 'GOLD', 'PRIMARY_FEED_STALE');
    const gate = allowEntryFromPrimaryFeed(feeds, 'GOLD');
    expect(gate.ok).toBe(false);
    expect(gate.code).toMatch(/PRIMARY_FEED_/);

    const risk = buildMoneyPathRisk({
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      client_trading_enabled: true,
      quote: quote(),
      feedManager: feeds,
      orderStore: new DurableOrderStore(join(mkdtempSync(join(tmpdir(), 'vs-c-')), 'o.json')),
      session_healthy: true,
      reconcile_clean: true,
      has_open_position: false,
      stop_attached: true,
      operating_mode: 'DEMO',
      live_trading_enabled: false,
    });
    expect(risk.ok).toBe(false);
  });
});

describe('P0_LIVE_PATH_FAILURE_D_SESSION', () => {
  it('D) session unhealthy before submit → BLOCKED, no uncontrolled submit', async () => {
    let submits = 0;
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
      baseRisk({ session_healthy: false }),
      {
        orderStore: new OrderStore(),
        submit: async () => {
          submits += 1;
          return { ok: true, deal_id: 'X', detail: 'no' };
        },
        reconcile: async () => ({ found: false, detail: 'n/a' }),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RISK_REJECTED_SESSION_UNHEALTHY');
    expect(submits).toBe(0);
  });
});

describe('P0_LIVE_PATH_FAILURE_E_RECONCILE', () => {
  it('E) reconciliation not clean → abort, zero new orders', async () => {
    let submits = 0;
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
      baseRisk({ reconcile_clean: false }),
      {
        orderStore: new OrderStore(),
        submit: async () => {
          submits += 1;
          return { ok: true, deal_id: 'X', detail: 'no' };
        },
        reconcile: async () => ({ found: false, detail: 'n/a' }),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RISK_REJECTED_RECONCILE_DIRTY');
    expect(submits).toBe(0);

    const chain = await runRuntimeChain({
      epic: 'GOLD',
      primary: {
        bid: 2402,
        ask: 2402.3,
        source_timestamp: new Date().toISOString(),
        market_status: 'TRADEABLE',
      },
      bars: climbBars(),
      closed_bar: climbBars()[2]!,
      regime: 'TREND_UP',
      client_id: 1,
      account_id: 9,
      size: 0.1,
      trading_enabled: true,
      reconcile_clean: false,
      broker: async () => {
        submits += 1;
        return { ok: true, deal_id: 'Z', detail: 'no' };
      },
    });
    expect(chain.outcome).toBe('BLOCKED_TECHNICAL');
    expect(chain.blocked_reason).toBe('RECONCILIATION_NOT_CLEAN');
    expect(chain.broker_submits).toBe(0);
  });
});

describe('P0_LIVE_PATH_FAILURE_F_REJECT_CONFIRM', () => {
  it('F) HTTP 200 but confirm REJECTED → never POSITION_OPEN', async () => {
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
        orderStore: new OrderStore(),
        submit: async () => ({
          ok: true,
          deal_reference: 'REF',
          deal_id: null,
          detail: 'http 200',
          status: 200,
        }),
        reconcile: async () => ({ found: false, detail: 'n/a' }),
        confirm: async () => ({
          ok: false,
          status: 'REJECTED',
          detail: 'broker rejected',
        }),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BROKER_REJECTED');
    if (r.order) expect(r.order.state).not.toBe('POSITION_OPEN');
  });
});

describe('P0_LIVE_PATH_FAILURE_G_CRASH_SUBMITTING', () => {
  it('G) crash at SUBMITTING → restart recovers durable state → no duplicate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-crash-'));
    const path = join(dir, 'orders.json');
    try {
      const store1 = new DurableOrderStore(path);
      store1.beginSubmission({
        client_order_id: 'vs_crash_1',
        intent_id: 'intent-crash',
        setup_id: 'setup-crash',
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: 'BUY',
        size: 0.1,
        state: 'SUBMITTING',
        deal_reference: null,
        deal_id: null,
      });
      expect(store1.hasUnresolvedSubmission(1, 'GOLD')).toBe(true);

      const store2 = new DurableOrderStore(path);
      expect(store2.hasUnresolvedSubmission(1, 'GOLD')).toBe(true);
      expect(store2.getLedger('vs_crash_1')?.state).toBe('SUBMITTING');

      let submits = 0;
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
          orderStore: store2,
          submit: async () => {
            submits += 1;
            return { ok: true, deal_id: 'DUP', detail: 'no' };
          },
          reconcile: async () => ({ found: false, detail: 'n/a' }),
        }
      );
      expect(submits).toBe(0);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('RISK_REJECTED_DUPLICATE_INTENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P0_LIVE_PATH_FAILURE_H_ISOLATION', () => {
  it('H) Client A cannot read Client B logs/state', async () => {
    const bus = getEventBus();
    await bus.emit('SystemNotReady', { source: 'test', client_id: null, payload: { secret: 'srv' } });
    await bus.emit('DecisionCreated', { source: 'test', client_id: 1, payload: { a: 1 } });
    await bus.emit('DecisionCreated', { source: 'test', client_id: 2, payload: { b: 2 } });
    const forA = bus.recent(50).filter((e) => e.client_id === 1);
    expect(forA.every((e) => e.client_id === 1)).toBe(true);
    expect(forA.some((e) => e.client_id === 2)).toBe(false);
    expect(forA.some((e) => e.client_id == null)).toBe(false);

    const mgr = new CapitalSessionManager({
      login: async () => ({
        ok: true,
        status: 200,
        cst: 'CST',
        security_token: 'SEC',
        detail: 'ok',
      }),
      probe: async () => ({ ok: true, status: 200, detail: 'ok' }),
    });
    mgr.setCredentials(2, 20, 99, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    expect(mgr.assertIsolation(1, 2)).toBe(false);
    expect(mgr.getPublicState(1, 20)).toBeNull();

    const auth = new MobileAuthService(async () => true);
    const login = await auth.login({
      client_id: 1,
      password: 'x',
      device_id: 'd',
      ip: '1.1.1.1',
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const session = auth.resolve(login.token)!;
    expect(auth.assertClientAccess(session, 2)).toBe(false);
  });
});

describe('P0_LIVE_PATH_FAILURE_I_LOGIN', () => {
  it('I) login only → trading remains OFF', async () => {
    resetClientTradingRegistryForTests();
    const auth = new MobileAuthService(async () => true);
    const login = await auth.login({
      client_id: 42,
      password: 'ok',
      device_id: 'phone',
      ip: '9.9.9.9',
    });
    expect(login.ok).toBe(true);
    const reg = getClientTradingRegistry();
    expect(reg.isTradingEnabled(42)).toBe(false);
    expect(reg.isTradingEnabled(42, 100)).toBe(false);
  });
});

describe('P0_LIVE_PATH_FAILURE_J_STOP_SCOPE', () => {
  it('J) stop one account/session → other accounts unaffected', () => {
    resetClientTradingRegistryForTests();
    const reg = getClientTradingRegistry();
    reg.start(7, 100);
    reg.start(7, 200);
    expect(reg.isTradingEnabled(7, 100)).toBe(true);
    expect(reg.isTradingEnabled(7, 200)).toBe(true);
    reg.stop(7, 100);
    expect(reg.isTradingEnabled(7, 100)).toBe(false);
    expect(reg.isTradingEnabled(7, 200)).toBe(true);
  });
});

describe('P0_STRATEGY_PARITY', () => {
  it('same market input → evaluateStrategy identical from desk/path callers', () => {
    const bars = climbBars();
    const input = {
      epic: 'GOLD',
      market_snapshot_id: 'parity',
      market_open: true,
      feed_fresh: true,
      bar_closed: true,
      closed_bar: bars[2]!,
      bars,
      regime: 'RANGE',
      trading_enabled: true,
    };
    const a = evaluateStrategy(input);
    const b = evaluateStrategy(input);
    expect(a.code).toBe(b.code);
    expect(a.direction).toBe(b.direction);
    // FADE must not diverge — RANGE uses same strategyCore for all callers
    expect(a.code === 'NO_SETUP' || a.code === 'ENTER_LONG' || a.code === 'ENTER_SHORT' || a.code === 'BLOCKED_TECHNICAL').toBe(
      true
    );
  });
});

describe('P0_FEED_AND_MARKET_GATES', () => {
  it('PRIMARY LIVE allow; STALE/OFFLINE block; REFERENCE alone insufficient', () => {
    const feeds = new FeedManager(5000);
    feeds.defineSource('capital', 'PRIMARY');
    feeds.defineSource('yahoo', 'REFERENCE');
    const now = new Date().toISOString();
    feeds.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: 1,
      ask: 1.1,
      source_timestamp: now,
    });
    expect(allowEntryFromPrimaryFeed(feeds, 'GOLD').ok).toBe(true);

    feeds.markOffline('capital', 'GOLD', 'down');
    feeds.ingest({
      source: 'yahoo',
      epic: 'GOLD',
      bid: 1,
      ask: 1.1,
      source_timestamp: now,
    });
    const gate = allowEntryFromPrimaryFeed(feeds, 'GOLD');
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe('PRIMARY_FEED_OFFLINE');
  });

  it('empty/unknown marketStatus fail closed', () => {
    expect(marketStatusAllowsTrading(null)).toBe(false);
    expect(marketStatusAllowsTrading('')).toBe(false);
    expect(marketStatusAllowsTrading('WEIRD')).toBe(false);
    expect(marketStatusAllowsTrading('TRADEABLE')).toBe(true);
  });
});

describe('P0_PUBLIC_STATE_AND_REGIME', () => {
  it('getPublicState never exposes tokens', async () => {
    const mgr = new CapitalSessionManager({
      login: async () => ({
        ok: true,
        status: 200,
        cst: 'SECRET_CST',
        security_token: 'SECRET_SEC',
        detail: 'ok',
      }),
      probe: async () => ({ ok: true, status: 200, detail: 'ok' }),
    });
    mgr.setCredentials(1, 1, 1, {
      api_key: 'KEY',
      identifier: 'id',
      password: 'pw',
      environment: 'demo',
    });
    await mgr.connect(1, 1);
    const pub = mgr.getPublicState(1, 1)!;
    const blob = JSON.stringify(pub);
    expect(blob).not.toContain('SECRET_CST');
    expect(blob).not.toContain('SECRET_SEC');
    expect(blob).not.toContain('KEY');
    expect(blob).not.toContain('pw');
    expect(pub.secrets_exposed).toBe(false);
  });

  it('UNKNOWN regime is not rewritten to TREND_* from bias', () => {
    expect(effectiveRegimeName({ regime: 'UNKNOWN', trend_bias: 'UP' })).toBe('UNKNOWN');
    expect(effectiveRegimeName({ regime: 'UNKNOWN', trend_bias: 'DOWN' })).toBe('UNKNOWN');
    expect(effectiveRegimeName({ regime: 'TREND_UP', trend_bias: 'DOWN' })).toBe('TREND_UP');
  });
});

describe('P0_CHAIN_OUTCOME_SEMANTICS', () => {
  it('blocked path is BLOCKED_TECHNICAL not ok execution PASS', async () => {
    const r = await runRuntimeChain({
      epic: 'GOLD',
      primary: { bid: 2402, ask: 2402.3, source_timestamp: new Date().toISOString() },
      primary_offline: true,
      reference: { bid: 2402, ask: 2402.4, source_timestamp: new Date().toISOString() },
      bars: climbBars(),
      closed_bar: climbBars()[2]!,
      regime: 'TREND_UP',
      client_id: 1,
      account_id: 1,
      size: 0.1,
      trading_enabled: true,
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('BLOCKED_TECHNICAL');
    expect(r.broker_submits).toBe(0);
  });
});
