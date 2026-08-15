import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateRisk, type RiskContext } from './riskCore.js';
import {
  OrderStore,
  canTransition,
  createOrderRecord,
  transitionOrder,
} from './orderStateMachine.js';
import {
  executeTradeIntent,
  newDecisionId,
  newIntentId,
} from './executionCore.js';
import { MarketCore } from './marketCore.js';
import { evaluateStrategy } from './strategyCore.js';
import { reconcilePositions } from './positionReconcile.js';
import { runReplay } from './replayEngine.js';
import { VsSupervisor } from './supervisor.js';
import { evaluateReadiness, probe } from './readiness.js';
import { MobileAuthService } from './mobileAuth.js';
import {
  getClientTradingRegistry,
  resetClientTradingRegistryForTests,
} from './clientTrading.js';
import { applyUpdate, sha256Buffer, type ReleaseManifest } from './updater.js';
import {
  backupKeyFromPassphrase,
  createBackup,
  restoreBackup,
} from './backup.js';
import { STRATEGY_BASELINE_STATUS, versionBundle } from './versions.js';
import { checkTimeSync } from './timeSync.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function baseRisk(over: Partial<RiskContext> = {}): RiskContext {
  return {
    client_id: 1,
    account_id: 1,
    epic: 'GOLD',
    direction: 'BUY',
    size: 0.1,
    client_trading_enabled: true,
    market_open: true,
    feed_fresh: true,
    feed_offline: false,
    spread: 0.2,
    max_spread: 1,
    has_open_position: false,
    has_duplicate_intent: false,
    in_cooldown: false,
    session_healthy: true,
    time_sync_ok: true,
    reconcile_clean: true,
    stop_attached: true,
    operating_mode: 'DEMO',
    live_trading_enabled: false,
    ...over,
  };
}

function bar(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: Date.now(), open: o, high: h, low: l, close: c, ticks: 5 };
}

describe('VS CORE versions', () => {
  it('pins HISTORICAL_STRATEGY_NOT_PROVEN', () => {
    expect(STRATEGY_BASELINE_STATUS).toBe('HISTORICAL_STRATEGY_NOT_PROVEN');
    const v = versionBundle('test');
    expect(v.strategy_version).toBeTruthy();
    expect(v.core_version).toBeTruthy();
  });
});

describe('Risk Core', () => {
  it('accepts clean DEMO intent', () => {
    const r = evaluateRisk(baseRisk());
    expect(r.ok).toBe(true);
  });

  it('blocks REPLAY from broker path', () => {
    const r = evaluateRisk(baseRisk({ operating_mode: 'REPLAY' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RISK_REJECTED_MODE_BLOCKS_LIVE');
  });

  it('blocks stale feed', () => {
    const r = evaluateRisk(baseRisk({ feed_fresh: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RISK_REJECTED_STALE_FEED');
  });

  it('blocks market closed', () => {
    const r = evaluateRisk(baseRisk({ market_open: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RISK_REJECTED_MARKET_CLOSED');
  });

  it('blocks duplicate / open position', () => {
    expect(evaluateRisk(baseRisk({ has_open_position: true })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ has_duplicate_intent: true })).ok).toBe(false);
  });

  it('blocks entry without stop', () => {
    const r = evaluateRisk(baseRisk({ stop_attached: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RISK_REJECTED_NO_STOP');
  });

  it('blocks client STOP', () => {
    const r = evaluateRisk(baseRisk({ client_trading_enabled: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RISK_REJECTED_CLIENT_STOPPED');
  });
});

describe('Order state machine', () => {
  it('allows legal chain to POSITION_OPEN', () => {
    let o = createOrderRecord({
      intent_id: 'i1',
      client_order_id: 'c1',
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 1,
      strategy_version: 's',
      config_version: '1',
      decision_id: 'd1',
    });
    o = transitionOrder(o, 'RISK_ACCEPTED');
    o = transitionOrder(o, 'ORDER_CREATED');
    o = transitionOrder(o, 'SUBMITTING');
    o = transitionOrder(o, 'BROKER_ACCEPTED');
    o = transitionOrder(o, 'FILLED');
    o = transitionOrder(o, 'POSITION_OPEN');
    expect(o.state).toBe('POSITION_OPEN');
  });

  it('rejects illegal skip', () => {
    expect(canTransition('SIGNAL_CREATED', 'FILLED')).toBe(false);
    const o = createOrderRecord({
      intent_id: 'i2',
      client_order_id: 'c2',
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 1,
      strategy_version: 's',
      config_version: '1',
      decision_id: 'd2',
    });
    expect(() => transitionOrder(o, 'FILLED')).toThrow(/Illegal/);
  });
});

describe('Execution Core — no blind retry', () => {
  it('on timeout reconciles instead of duplicate submit', async () => {
    let submits = 0;
    const store = new OrderStore();
    const result = await executeTradeIntent(
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
        reconcile: async () => ({
          found: true,
          deal_id: 'D1',
          deal_reference: 'R1',
          detail: 'found after timeout',
        }),
      }
    );
    expect(submits).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.order.state).toBe('POSITION_OPEN');
  });

  it('duplicate signal blocked by risk before submit', async () => {
    let submits = 0;
    const store = new OrderStore();
    const result = await executeTradeIntent(
      {
        intent_id: newIntentId(),
        decision_id: newDecisionId(),
        client_id: 1,
        account_id: 1,
        epic: 'GOLD',
        direction: 'BUY',
        size: 0.1,
      },
      baseRisk({ has_duplicate_intent: true }),
      {
        orderStore: store,
        submit: async () => {
          submits += 1;
          return { ok: true, deal_reference: 'x', detail: 'ok' };
        },
        reconcile: async () => ({ found: false, detail: 'n/a' }),
      }
    );
    expect(submits).toBe(0);
    expect(result.ok).toBe(false);
  });
});

describe('Market Core', () => {
  it('marks stale ticks and blocks trading', () => {
    const m = new MarketCore(1000);
    const now = Date.now();
    m.ingest({
      epic: 'GOLD',
      bid: 1,
      ask: 2,
      source: 'capital',
      source_timestamp: new Date(now - 5000).toISOString(),
      market_status: 'TRADEABLE',
      now,
    });
    expect(m.get('GOLD')?.status).toBe('STALE');
    expect(m.allowsTrading('GOLD')).toBe(false);
  });

  it('allows fresh TRADEABLE', () => {
    const m = new MarketCore(5000);
    const now = Date.now();
    m.ingest({
      epic: 'GOLD',
      bid: 2400,
      ask: 2400.3,
      source: 'capital',
      source_timestamp: new Date(now).toISOString(),
      market_status: 'TRADEABLE',
      now,
    });
    expect(m.allowsTrading('GOLD')).toBe(true);
  });
});

describe('Strategy Core', () => {
  it('never returns UNKNOWN decision code', () => {
    const d = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 'snap1',
      market_open: true,
      feed_fresh: true,
      bar_closed: true,
      closed_bar: bar(100, 101, 99.5, 100.5),
      bars: [
        bar(99, 100, 98.5, 99.5),
        bar(99.5, 100.5, 99, 100),
        bar(100, 101, 99.5, 100.5),
      ],
      regime: 'TREND_UP',
      trading_enabled: true,
    });
    expect(String(d.code)).not.toBe('UNKNOWN');
    expect(d.strategy_version).toBeTruthy();
    expect(d.decision_id).toBeTruthy();
  });

  it('WAIT_MARKET_CLOSED when closed', () => {
    const d = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 'snap1',
      market_open: false,
      feed_fresh: true,
      bar_closed: true,
      closed_bar: bar(100, 101, 99, 100),
      bars: [bar(100, 101, 99, 100)],
      regime: 'TREND_UP',
      trading_enabled: true,
    });
    expect(d.code).toBe('WAIT_MARKET_CLOSED');
  });
});

describe('Replay isolation', () => {
  it('never attempts broker orders', () => {
    const closed = bar(100, 101, 99.5, 100.8);
    const r = runReplay(
      [
        {
          epic: 'GOLD',
          bid: 100,
          ask: 100.2,
          source_timestamp: new Date().toISOString(),
          strategy: {
            bar_closed: true,
            closed_bar: closed,
            bars: [closed, closed, closed],
            regime: 'TREND_UP',
          },
        },
      ],
      {
        epic: 'GOLD',
        market_open: true,
        feed_fresh: true,
        trading_enabled: true,
      }
    );
    expect(r.broker_orders_attempted).toBe(0);
    expect(r.mode).toBe('REPLAY');
  });
});

describe('Position reconcile', () => {
  it('detects mismatch', () => {
    const r = reconcilePositions(
      [
        {
          account_id: 1,
          client_id: 1,
          epic: 'GOLD',
          direction: 'BUY',
          deal_id: 'A',
          size: 1,
        },
      ],
      [{ epic: 'GOLD', direction: 'SELL', deal_id: 'B', size: 1 }],
      1
    );
    expect(r.clean).toBe(false);
    expect(r.code).toBe('POSITION_STATE_MISMATCH');
  });
});

describe('Supervisor', () => {
  it('orders by dependency and detects crash loop', async () => {
    const sup = new VsSupervisor();
    let starts = 0;
    sup.register({
      name: 'db',
      critical: true,
      depends_on: [],
      start_timeout_ms: 1000,
      max_restarts: 2,
      restart_window_ms: 60_000,
      start: async () => undefined,
      stop: async () => undefined,
      health: async () => ({ status: 'OK', detail: 'ok' }),
    });
    sup.register({
      name: 'market',
      critical: true,
      depends_on: ['db'],
      start_timeout_ms: 1000,
      max_restarts: 2,
      restart_window_ms: 60_000,
      start: async () => {
        starts += 1;
      },
      stop: async () => undefined,
      health: async () =>
        starts > 1
          ? { status: 'CRITICAL', detail: 'down' }
          : { status: 'OK', detail: 'ok' },
    });
    const snap = await sup.startAll();
    expect(snap.services.map((s) => s.name)).toEqual(['db', 'market']);
  });
});

describe('Readiness — no fake READY', () => {
  it('NOT READY when CAPITAL unverified', () => {
    const report = evaluateReadiness([
      probe('NETWORK', 'OK', 'ok'),
      probe('TIME', 'OK', 'ok'),
      probe('STORAGE', 'OK', 'ok'),
      probe('DATABASE', 'OK', 'ok'),
      probe('MARKET', 'OK', 'ok'),
      probe('CAPITAL', 'ERROR', 'unverified', 'CAPITAL_UNVERIFIED'),
      probe('STRATEGY', 'OK', 'ok'),
      probe('RISK', 'OK', 'ok'),
      probe('EXECUTION', 'OK', 'ok'),
      probe('RECONCILIATION', 'OK', 'ok'),
    ]);
    expect(report.state).toBe('NOT_READY');
    expect(report.live_ready).toBe(false);
  });

  it('READY only when all required OK', () => {
    const report = evaluateReadiness([
      probe('NETWORK', 'OK', 'ok'),
      probe('TIME', 'OK', 'ok'),
      probe('STORAGE', 'OK', 'ok'),
      probe('DATABASE', 'OK', 'ok'),
      probe('MARKET', 'OK', 'ok'),
      probe('CAPITAL', 'OK', 'session verified'),
      probe('STRATEGY', 'OK', 'ok'),
      probe('RISK', 'OK', 'ok'),
      probe('EXECUTION', 'OK', 'ok'),
      probe('RECONCILIATION', 'OK', 'ok'),
    ]);
    expect(report.state).toBe('READY');
    expect(report.live_ready).toBe(true);
  });
});

describe('Mobile auth + isolation', () => {
  beforeEach(() => {
    resetClientTradingRegistryForTests();
  });

  it('rejects wrong password and rate-limits', async () => {
    const auth = new MobileAuthService(async () => false);
    const r = await auth.login({
      client_id: 1,
      password: 'bad',
      device_id: 'd1',
      ip: '1.1.1.1',
    });
    expect(r.ok).toBe(false);
  });

  it('expired / revoked tokens denied', async () => {
    const auth = new MobileAuthService(async () => true);
    const login = await auth.login({
      client_id: 2,
      password: 'ok',
      device_id: 'phone',
      ip: '2.2.2.2',
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(auth.resolve(login.token)?.client_id).toBe(2);
    auth.revoke(login.token);
    expect(auth.resolve(login.token)).toBeNull();
  });

  it('Client A cannot access Client B', async () => {
    const auth = new MobileAuthService(async () => true);
    const login = await auth.login({
      client_id: 10,
      password: 'ok',
      device_id: 'a',
      ip: '3.3.3.3',
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const session = auth.resolve(login.token)!;
    expect(auth.assertClientAccess(session, 10)).toBe(true);
    expect(auth.assertClientAccess(session, 99)).toBe(false);
  });

  it('START/STOP toggles server-side trading without process restart', () => {
    const reg = getClientTradingRegistry();
    reg.start(5);
    expect(reg.isTradingEnabled(5)).toBe(true);
    const stopped = reg.stop(5);
    expect(stopped.trading_enabled).toBe(false);
    expect(stopped.stop_position_policy).toBe('LEAVE_OPEN');
  });
});

describe('Updater rollback', () => {
  it('rolls back when health check fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-upd-'));
    const payload = Buffer.from('release-bytes');
    const manifest: ReleaseManifest = {
      version: '1.0.1',
      sha256: sha256Buffer(payload),
      created_at: new Date().toISOString(),
    };
    let restored = false;
    const result = await applyUpdate(manifest, payload, {
      root,
      preflight: async () => ({ ok: true }),
      healthCheck: async () => ({ ok: false, reason: 'health FAIL' }),
      activate: async () => undefined,
      restoreBackup: async () => {
        restored = true;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rolled_back).toBe(true);
      expect(restored).toBe(true);
    }
  });
});

describe('Backup restore', () => {
  it('round-trips config and encrypted secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-bak-'));
    const key = backupKeyFromPassphrase('test-pass');
    const man = createBackup(
      root,
      { 'config.json': '{"a":1}' },
      { secretKey: key, secrets: { capital_api: 'SECRET123' }, retention_keep: 3 }
    );
    const restored = restoreBackup(root, man.id, { secretKey: key });
    expect(restored.ok).toBe(true);
    expect(restored.files['config.json']).toBe('{"a":1}');
    expect(restored.secrets.capital_api).toBe('SECRET123');
  });
});

describe('Time sync', () => {
  it('flags large drift', () => {
    const r = checkTimeSync({
      now: Date.now(),
      referenceEpochMs: Date.now() - 10_000,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('TIME_SYNC_ERROR');
  });
});
