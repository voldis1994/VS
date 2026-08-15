/**
 * Comprehensive VS CORE proof tests — real call paths, not file existence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MarketCore } from './marketCore.js';
import { FeedManager } from './feedManager.js';
import { runRuntimeChain, runDuplicateProtectionTest } from './runtimeChain.js';
import { runStrategyRegression } from './strategyRegression.js';
import {
  OrderStore,
  createOrderRecord,
  transitionOrder,
  canTransition,
} from './orderStateMachine.js';
import { executeTradeIntent, newDecisionId, newIntentId } from './executionCore.js';
import { evaluateRisk } from './riskCore.js';
import { reconcilePositions } from './positionReconcile.js';
import { runCrashRecovery } from './crashRecovery.js';
import { CapitalSessionManager } from './capitalSessionManager.js';
import { VsSupervisor } from './supervisor.js';
import { evaluateReadiness, probe } from './readiness.js';
import {
  getIncidentCenter,
  resetIncidentCenterForTests,
} from './incidentCenter.js';
import { runSoakTest } from './soakTest.js';
import {
  evaluateDatabaseGateSafe,
  simulateDbFixture,
} from './databaseGate.js';
import { applyUpdate, sha256Buffer } from './updater.js';
import { backupKeyFromPassphrase, createBackup, restoreBackup } from './backup.js';
import { MobileAuthService } from './mobileAuth.js';
import { runCapitalDemoVerify } from './capitalDemoVerify.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function bar(o: number, h: number, l: number, c: number) {
  return { open_time_ms: Date.now(), open: o, high: h, low: l, close: c, ticks: 4 };
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
    in_cooldown: false,
    session_healthy: true,
    time_sync_ok: true,
    reconcile_clean: true,
    stop_attached: true,
    operating_mode: 'DEMO' as const,
    live_trading_enabled: false,
    ...over,
  };
}

describe('CURRENT_STRATEGY_REGRESSION', () => {
  it('deterministic locked baseline PASS', () => {
    const a = runStrategyRegression();
    const b = runStrategyRegression();
    expect(a.failed).toBe(0);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe('FEED_SAFETY', () => {
  it('PRIMARY LIVE allows; STALE/OFFLINE/reference-only block', () => {
    const fm = new FeedManager(2000);
    fm.defineSource('capital', 'PRIMARY');
    fm.defineSource('yahoo', 'REFERENCE');
    const now = Date.now();
    fm.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: 1,
      ask: 1.1,
      source_timestamp: new Date(now).toISOString(),
      now,
    });
    expect(fm.snapshot('GOLD').allows_execution).toBe(true);

    fm.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: 1,
      ask: 1.1,
      source_timestamp: new Date(now - 10_000).toISOString(),
      now,
    });
    expect(fm.snapshot('GOLD').allows_execution).toBe(false);
    expect(fm.snapshot('GOLD').block_reason).toBe('PRIMARY_FEED_STALE');

    fm.markOffline('capital', 'GOLD');
    fm.ingest({
      source: 'yahoo',
      epic: 'GOLD',
      bid: 1,
      ask: 1.1,
      source_timestamp: new Date(now).toISOString(),
      now,
    });
    const snap = fm.snapshot('GOLD');
    expect(snap.allows_execution).toBe(false);
    expect(snap.block_reason).toBe('PRIMARY_FEED_OFFLINE');
  });
});

describe('FEED_AGE_AND_QUALITY', () => {
  it('fresh / delayed / duplicate / out-of-order / malformed / future', () => {
    const m = new MarketCore(1000);
    const now = Date.now();
    const fresh = m.ingest({
      epic: 'GOLD',
      bid: 10,
      ask: 10.1,
      source: 'capital',
      source_timestamp: new Date(now).toISOString(),
      source_sequence: 1,
      market_status: 'TRADEABLE',
      now,
    });
    expect(fresh.quality).toBe('OK');
    expect(fresh.accepted).toBe(true);

    const delayed = m.ingest({
      epic: 'GOLD',
      bid: 10,
      ask: 10.1,
      source: 'capital',
      source_timestamp: new Date(now - 5000).toISOString(),
      source_sequence: 2,
      market_status: 'TRADEABLE',
      now,
    });
    expect(delayed.quality).toBe('STALE');
    expect(delayed.accepted).toBe(false);

    const dup = m.ingest({
      epic: 'GOLD',
      bid: 10,
      ask: 10.1,
      source: 'capital',
      source_timestamp: new Date(now).toISOString(),
      source_sequence: 1,
      market_status: 'TRADEABLE',
      now,
    });
    expect(dup.quality).toBe('DUPLICATE');

    const ooo = m.ingest({
      epic: 'GOLD',
      bid: 10.2,
      ask: 10.3,
      source: 'capital',
      source_timestamp: new Date(now + 1).toISOString(),
      source_sequence: 0,
      market_status: 'TRADEABLE',
      now: now + 1,
    });
    expect(ooo.quality).toBe('OUT_OF_ORDER');

    const bad = m.ingest({
      epic: 'GOLD',
      bid: null,
      ask: 1,
      source: 'capital',
      source_timestamp: new Date(now).toISOString(),
      now,
    });
    expect(bad.quality).toBe('INVALID');

    const future = m.ingest({
      epic: 'SILVER',
      bid: 1,
      ask: 1.1,
      source: 'capital',
      source_timestamp: new Date(now + 60_000).toISOString(),
      now,
    });
    expect(future.quality).toBe('FUTURE_TIMESTAMP');
  });
});

describe('RUNTIME_CHAIN', () => {
  it('executes MARKET→…→EXECUTION path and blocks when PRIMARY offline despite reference LIVE', async () => {
    const now = new Date().toISOString();
    const closed = bar(2400, 2403, 2399, 2402.8);
    const bars = [bar(2398, 2400, 2397, 2399.5), bar(2399.5, 2401, 2399, 2401), closed];
    const blocked = await runRuntimeChain({
      epic: 'GOLD',
      primary: { bid: 2402, ask: 2402.3, source_timestamp: now },
      reference: { bid: 2402, ask: 2402.4, source_timestamp: now },
      primary_offline: true,
      bars,
      closed_bar: closed,
      regime: 'TREND_UP',
      client_id: 1,
      account_id: 1,
      size: 0.1,
      trading_enabled: true,
    });
    expect(blocked.broker_submits).toBe(0);
    expect(blocked.blocked_reason).toBe('PRIMARY_FEED_OFFLINE');

    const live = await runRuntimeChain({
      epic: 'GOLD',
      primary: { bid: 2402, ask: 2402.3, source_timestamp: now, market_status: 'TRADEABLE' },
      bars,
      closed_bar: closed,
      regime: 'TREND_UP',
      client_id: 1,
      account_id: 1,
      size: 0.1,
      trading_enabled: true,
    });
    expect(live.steps.find((s) => s.name === 'STRATEGY_DECISION')).toBeTruthy();
    expect(live.steps.find((s) => s.name === 'FEED_MANAGER')).toBeTruthy();
    if (live.decision?.code === 'ENTER_LONG' || live.decision?.code === 'ENTER_SHORT') {
      expect(live.broker_submits).toBe(1);
      expect(live.order?.state).toBe('POSITION_OPEN');
    }
  });
});

describe('DUPLICATE_PROTECTION', () => {
  it('same setup twice → at most one broker submission', async () => {
    const r = await runDuplicateProtectionTest();
    expect(r.ok).toBe(true);
    expect(r.submits).toBeLessThanOrEqual(1);
  });
});

describe('TIMEOUT_RECONCILE', () => {
  it('timeout after submit reconciles — no second blind submit', async () => {
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
        reconcile: async () => ({
          found: true,
          deal_id: 'DX',
          deal_reference: 'RX',
          detail: 'found at broker',
        }),
      }
    );
    expect(submits).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.state).toBe('POSITION_OPEN');
  });
});

describe('ORDER_STATE_MACHINE', () => {
  it('legal chain + illegal transition raises', () => {
    let o = createOrderRecord({
      intent_id: 'i',
      client_order_id: 'c',
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 1,
      strategy_version: 's',
      config_version: '1',
      decision_id: 'd',
    });
    o = transitionOrder(o, 'RISK_ACCEPTED');
    o = transitionOrder(o, 'ORDER_CREATED');
    o = transitionOrder(o, 'SUBMITTING');
    expect(canTransition('SUBMITTING', 'REJECTED')).toBe(true);
    o = transitionOrder(o, 'REJECTED');
    expect(() => transitionOrder(o, 'FILLED')).toThrow(/Illegal/);
    resetIncidentCenterForTests();
    try {
      transitionOrder(o, 'BROKER_ACCEPTED');
    } catch (e) {
      getIncidentCenter().raise({
        severity: 'ERROR',
        component: 'order-sm',
        error_code: 'ILLEGAL_TRANSITION',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    expect(getIncidentCenter().list({ unresolved_only: true }).length).toBeGreaterThan(0);
  });
});

describe('RECONCILIATION', () => {
  it('match / local-missing / broker-missing / direction mismatch', () => {
    expect(
      reconcilePositions(
        [{ account_id: 1, client_id: 1, epic: 'GOLD', direction: 'BUY', deal_id: 'A', size: 1 }],
        [{ epic: 'GOLD', direction: 'BUY', deal_id: 'A', size: 1 }],
        1
      ).clean
    ).toBe(true);
    expect(
      reconcilePositions(
        [],
        [{ epic: 'GOLD', direction: 'BUY', deal_id: 'A', size: 1 }],
        1
      ).code
    ).toBe('POSITION_STATE_MISMATCH');
    expect(
      reconcilePositions(
        [{ account_id: 1, client_id: 1, epic: 'GOLD', direction: 'BUY', deal_id: 'A', size: 1 }],
        [],
        1
      ).code
    ).toBe('POSITION_STATE_MISMATCH');
    expect(
      reconcilePositions(
        [{ account_id: 1, client_id: 1, epic: 'GOLD', direction: 'BUY', deal_id: 'A', size: 1 }],
        [{ epic: 'GOLD', direction: 'SELL', deal_id: 'B', size: 1 }],
        1
      ).mismatches[0]!.detail
    ).toMatch(/Direction mismatch/);
  });
});

describe('CRASH_RECOVERY', () => {
  it('blocks entries on dirty reconcile; allows when clean', async () => {
    const mgr = new CapitalSessionManager({
      login: async () => ({
        ok: true,
        status: 200,
        cst: 'c',
        security_token: 's',
        detail: 'ok',
      }),
      probe: async () => ({ ok: true, status: 200, detail: 'ok' }),
    });
    mgr.setCredentials(1, 1, 1, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    const dirty = await runCrashRecovery({
      networkOk: async () => true,
      sessionManager: mgr,
      client_id: 1,
      account_id: 1,
      loadLocalPositions: async () => [
        { account_id: 1, client_id: 1, epic: 'GOLD', direction: 'BUY', deal_id: 'L', size: 1 },
      ],
      loadBrokerPositions: async () => [],
      loadWorkingOrders: async () => ({ ok: true, count: 0, detail: 'n' }),
      loadRecentFills: async () => ({ ok: true, count: 0, detail: 'n' }),
      databaseOk: async () => true,
      restoreStrategy: async () => ({ ok: true, detail: 'ok' }),
    });
    expect(dirty.entries_allowed).toBe(false);

    mgr.setCredentials(2, 2, 2, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    const clean = await runCrashRecovery({
      networkOk: async () => true,
      sessionManager: mgr,
      client_id: 2,
      account_id: 2,
      loadLocalPositions: async () => [],
      loadBrokerPositions: async () => [],
      loadWorkingOrders: async () => ({ ok: true, count: 0, detail: 'n' }),
      loadRecentFills: async () => ({ ok: true, count: 0, detail: 'n' }),
      databaseOk: async () => true,
      restoreStrategy: async () => ({ ok: true, detail: 'ok' }),
    });
    expect(clean.entries_allowed).toBe(true);
  });
});

describe('CAPITAL_SESSION_FIXTURES', () => {
  it('401/403/429/timeout/refresh/reconnect fixtures', async () => {
    const rate = new CapitalSessionManager({
      login: async () => ({ ok: false, status: 429, detail: 'rl' }),
      probe: async () => ({ ok: false, status: 429, detail: 'rl' }),
    });
    rate.setCredentials(1, 1, 1, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    expect((await rate.connect(1, 1)).health).toBe('RATE_LIMITED');

    let logins = 0;
    const auth = new CapitalSessionManager({
      login: async () => {
        logins += 1;
        return {
          ok: true,
          status: 200,
          cst: `c${logins}`,
          security_token: `t${logins}`,
          detail: 'ok',
        };
      },
      probe: async () => ({ ok: false, status: 401, detail: 'expired' }),
    });
    auth.setCredentials(2, 2, 2, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    await auth.connect(2, 2);
    await auth.verify(2, 2);
    expect(logins).toBeGreaterThanOrEqual(2);

    const failLogin = new CapitalSessionManager({
      login: async () => ({ ok: false, status: 403, detail: 'forbidden' }),
      probe: async () => ({ ok: false, status: 403, detail: 'forbidden' }),
    });
    failLogin.setCredentials(3, 3, 3, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    expect((await failLogin.connect(3, 3)).health).toBe('ERROR');
  });
});

describe('SUPERVISOR_READINESS', () => {
  it('crash-loop and NOT READY without capital', async () => {
    const sup = new VsSupervisor();
    let starts = 0;
    sup.register({
      name: 'exec',
      critical: true,
      depends_on: [],
      start_timeout_ms: 200,
      max_restarts: 2,
      restart_window_ms: 60_000,
      start: async () => {
        starts += 1;
      },
      stop: async () => undefined,
      health: async () => ({ status: 'CRITICAL', detail: 'down' }),
    });
    await sup.startAll();
    await sup.heartbeat();
    await sup.heartbeat();
    await sup.heartbeat();
    const snap = await sup.heartbeat();
    expect(
      snap.overall === 'CRITICAL_SERVICE_CRASH_LOOP' || snap.overall === 'NOT_READY'
    ).toBe(true);

    const ready = evaluateReadiness([
      probe('NETWORK', 'OK', 'ok'),
      probe('TIME', 'OK', 'ok'),
      probe('STORAGE', 'OK', 'ok'),
      probe('DATABASE', 'OK', 'ok'),
      probe('MARKET', 'OK', 'ok'),
      probe('CAPITAL', 'ERROR', 'no', 'CAPITAL_UNVERIFIED'),
      probe('STRATEGY', 'OK', 'ok'),
      probe('RISK', 'OK', 'ok'),
      probe('EXECUTION', 'OK', 'ok'),
      probe('RECONCILIATION', 'OK', 'ok'),
    ]);
    expect(ready.state).toBe('NOT_READY');
    expect(ready.live_ready).toBe(false);
  });
});

describe('SOAK_MEMORY', () => {
  it('bounded growth over many ticks', async () => {
    const r = await runSoakTest({ events: 15_000, maxGrowthMb: 100 });
    expect(r.ok).toBe(true);
    expect(r.bus_retained).toBeLessThanOrEqual(500);
  });
});

describe('DATABASE_GATE', () => {
  it('blocks trading on down/readonly/schema/corrupt', () => {
    expect(evaluateDatabaseGateSafe(simulateDbFixture('ok')).trading_allowed).toBe(true);
    expect(evaluateDatabaseGateSafe(simulateDbFixture('down')).reason_code).toBe(
      'DATABASE_UNAVAILABLE'
    );
    expect(evaluateDatabaseGateSafe(simulateDbFixture('readonly')).reason_code).toBe(
      'DATABASE_WRITE_FAILURE'
    );
    expect(evaluateDatabaseGateSafe(simulateDbFixture('schema_mismatch')).reason_code).toBe(
      'DATABASE_SCHEMA_MISMATCH'
    );
    expect(evaluateDatabaseGateSafe(simulateDbFixture('corrupt_record')).trading_allowed).toBe(
      false
    );
  });
});

describe('BACKUP_RESTORE_UPDATER', () => {
  it('backup restore + corrupted package rejected + rollback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-br-'));
    const key = backupKeyFromPassphrase('x');
    const man = createBackup(root, { a: '1' }, { secretKey: key, secrets: { s: 'secret' } });
    const rest = restoreBackup(root, man.id, { secretKey: key });
    expect(rest.ok).toBe(true);
    expect(rest.secrets.s).toBe('secret');

    const payload = Buffer.from('good');
    const bad = await applyUpdate(
      {
        version: '1',
        sha256: 'deadbeef',
        created_at: new Date().toISOString(),
      },
      payload,
      {
        root: mkdtempSync(join(tmpdir(), 'vs-up-')),
        preflight: async () => ({ ok: true }),
        healthCheck: async () => ({ ok: true }),
        activate: async () => undefined,
        restoreBackup: async () => undefined,
      }
    );
    expect(bad.ok).toBe(false);

    const goodPayload = Buffer.from('pkg');
    const rb = await applyUpdate(
      {
        version: '2',
        sha256: sha256Buffer(goodPayload),
        created_at: new Date().toISOString(),
      },
      goodPayload,
      {
        root: mkdtempSync(join(tmpdir(), 'vs-up2-')),
        preflight: async () => ({ ok: true }),
        healthCheck: async () => ({ ok: false, reason: 'boom' }),
        activate: async () => undefined,
        restoreBackup: async () => undefined,
      }
    );
    expect(rb.ok).toBe(true);
    if (rb.ok) expect(rb.rolled_back).toBe(true);
  });
});

describe('SECURITY_ISOLATION', () => {
  it('auth failures + client isolation', async () => {
    const auth = new MobileAuthService(async (id, pw) => id === 1 && pw === 'good');
    expect(
      (await auth.login({ client_id: 1, password: 'bad', device_id: 'd', ip: '1.1.1.1' })).ok
    ).toBe(false);
    const good = await auth.login({
      client_id: 1,
      password: 'good',
      device_id: 'd',
      ip: '1.1.1.1',
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const s = auth.resolve(good.token)!;
    expect(auth.assertClientAccess(s, 99)).toBe(false);
    auth.revoke(good.token);
    expect(auth.resolve(good.token)).toBeNull();
    expect(evaluateRisk(baseRisk({ size: -1 })).ok).toBe(false);
  });
});

describe('CAPITAL_DEMO_HARNESS', () => {
  it('returns EXTERNAL_BLOCKER without credentials', async () => {
    const r = await runCapitalDemoVerify({});
    expect(r.status).toBe('EXTERNAL_BLOCKER');
    expect(r.code).toBe('EXTERNAL_BLOCKER_CAPITAL_DEMO_CREDENTIALS');
  });
});

describe('RISK_CORE', () => {
  it('rejects stale/closed/no-stop/stopped client', () => {
    expect(evaluateRisk(baseRisk({ feed_fresh: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ market_open: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ stop_attached: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk({ client_trading_enabled: false })).ok).toBe(false);
    expect(evaluateRisk(baseRisk()).ok).toBe(true);
  });
});
