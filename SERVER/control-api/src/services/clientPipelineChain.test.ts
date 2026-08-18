/**
 * Production harden tests: pipeline auth, idempotency, heartbeat status, isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeIntentToSubscriptions } from './intentFanout.js';
import {
  authorizePipelineRequest,
  isEpicBeingAnalyzed,
  notePipelineHeartbeat,
  resetPipelineBridgeForTests,
  getPipelineBridgeStatus,
} from './pipelineBridge.js';
import { computeClientRobotStatus } from './clientPanel.js';

const createCapitalPosition = vi.fn();
const acquireCapitalSession = vi.fn();
const listCapitalOpenPositions = vi.fn();
const fetchCapitalMarketQuote = vi.fn();
const fetchCapitalMinutePrices = vi.fn();
const emitToClient = vi.fn();
const listActiveSubscriptionsForEpic = vi.fn();
const poolQuery = vi.fn();

const claimedKeys = new Set<string>();
const claimRows = new Map<string, { status: string; result_summary: unknown }>();
const intentDedupe = new Map<string, unknown>();

vi.mock('./capitalCom.js', () => ({
  createCapitalPosition: (...a: unknown[]) => createCapitalPosition(...a),
  acquireCapitalSession: (...a: unknown[]) => acquireCapitalSession(...a),
  listCapitalOpenPositions: (...a: unknown[]) => listCapitalOpenPositions(...a),
  fetchCapitalMarketQuote: (...a: unknown[]) => fetchCapitalMarketQuote(...a),
  fetchCapitalMinutePrices: (...a: unknown[]) => fetchCapitalMinutePrices(...a),
  computeSafetyCushionStopLevel: () => 1995,
  isLateMoveOnOneMinute: () => false,
}));

vi.mock('./clientEvents.js', () => ({
  emitToClient: (...a: unknown[]) => emitToClient(...a),
}));

vi.mock('./clientSubscriptions.js', () => ({
  listActiveSubscriptionsForEpic: (...a: unknown[]) => listActiveSubscriptionsForEpic(...a),
  noteBrokerOk: vi.fn(),
  noteBrokerError: vi.fn(),
}));

vi.mock('../db/pool.js', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a) },
}));

vi.mock('../security/encryption.js', () => ({
  decrypt: () => 'secret',
}));

const { hasEntryEnabledRobot, offerCalcEntry, listRunningHandsForEpic } = vi.hoisted(() => ({
  hasEntryEnabledRobot: vi.fn(() => false),
  offerCalcEntry: vi.fn(() => ({ queued: true, running: false })),
  listRunningHandsForEpic: vi.fn(() => []),
}));

vi.mock('./robotDesk.js', () => ({
  attachManageOnlyRobot: vi.fn(async () => undefined),
  listRobotSessions: () => [],
  stopRobotSession: vi.fn(async () => undefined),
  hasEntryEnabledRobot: (accountId: number, epic: string) => hasEntryEnabledRobot(accountId, epic),
  offerCalcEntry: (input: unknown) => offerCalcEntry(input),
  listRunningHandsForEpic: (epic: string) => listRunningHandsForEpic(epic),
}));

function sub(partial: {
  client_id: number;
  account_id: number;
  epic: string;
  lot_size: number;
}) {
  return {
    client_id: partial.client_id,
    client_name: `Client ${partial.client_id}`,
    account_id: partial.account_id,
    connection_id: partial.account_id * 10,
    epic: partial.epic,
    display_name: partial.epic,
    lot_size: partial.lot_size,
    instrument_id: 100 + partial.client_id,
  };
}

function claimKey(idem: string, clientId: number, accountId: number) {
  return `${idem}|${clientId}|${accountId}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  hasEntryEnabledRobot.mockReturnValue(false);
  offerCalcEntry.mockReturnValue({ queued: true, running: false });
  listRunningHandsForEpic.mockReturnValue([]);
  resetPipelineBridgeForTests();
  claimedKeys.clear();
  claimRows.clear();
  intentDedupe.clear();

  poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = String(sql);

    if (s.includes('pipeline_intent_dedupe') && s.includes('INSERT')) {
      const key = String(params?.[0]);
      if (intentDedupe.has(key)) return { rows: [] };
      intentDedupe.set(key, null);
      return { rows: [{ idempotency_key: key }] };
    }
    if (s.includes('pipeline_intent_dedupe') && s.includes('SELECT')) {
      const key = String(params?.[0]);
      if (!intentDedupe.has(key)) return { rows: [] };
      return { rows: [{ fanout_summary: intentDedupe.get(key) }] };
    }
    if (s.includes('pipeline_intent_dedupe') && s.includes('UPDATE')) {
      const key = String(params?.[0]);
      intentDedupe.set(key, params?.[1] ? JSON.parse(String(params[1])) : null);
      return { rows: [] };
    }

    if (s.includes('pipeline_execution_claims') && s.includes('INSERT')) {
      const key = claimKey(String(params?.[0]), Number(params?.[1]), Number(params?.[2]));
      if (claimedKeys.has(key)) return { rows: [] };
      claimedKeys.add(key);
      claimRows.set(key, { status: 'claimed', result_summary: null });
      return { rows: [{ client_id: params?.[1] }] };
    }
    if (s.includes('pipeline_execution_claims') && s.includes('SELECT')) {
      const key = claimKey(String(params?.[0]), Number(params?.[1]), Number(params?.[2]));
      const row = claimRows.get(key);
      return row ? { rows: [row] } : { rows: [] };
    }
    if (s.includes('pipeline_execution_claims') && s.includes('UPDATE')) {
      const key = claimKey(String(params?.[0]), Number(params?.[1]), Number(params?.[2]));
      claimRows.set(key, {
        status: 'completed',
        result_summary: params?.[3] ? JSON.parse(String(params[3])) : null,
      });
      return { rows: [] };
    }

    if (s.includes('ba.enabled')) return { rows: [{ id: 1 }] };
    if (s.includes('FROM broker_connections')) {
      return {
        rows: [{ environment: 'demo', identifier: 'id', broker_name: 'capital_com' }],
      };
    }
    if (s.includes('api_credential_metadata')) {
      return {
        rows: [
          { credential_type: 'api_key', ciphertext: 'x', iv: 'y', tag: 'z' },
          { credential_type: 'password', ciphertext: 'x', iv: 'y', tag: 'z' },
        ],
      };
    }
    if (s.includes('external_account_id')) {
      return { rows: [{ external_account_id: 'XYZ' }] };
    }
    if (s.includes('INSERT INTO trade_intents')) return { rows: [{ id: 42 }] };
    if (s.includes('UPDATE trade_intents') || s.includes('INSERT INTO positions')) {
      return { rows: [] };
    }
    return { rows: [{ id: 1 }] };
  });

  acquireCapitalSession.mockResolvedValue({ ok: true, session: { token: 't' } });
  listCapitalOpenPositions.mockResolvedValue({ ok: true, positions: [] });
  fetchCapitalMarketQuote.mockResolvedValue({
    epic: 'XAUUSD',
    bid: 2000,
    ask: 2000.5,
    mid: 2000.25,
    spread: 0.5,
    min_stop_distance: 0.5,
    raw_ok: true,
  });
  fetchCapitalMinutePrices.mockResolvedValue({
    ok: true,
    candles: Array.from({ length: 3 }, (_, i) => ({
      open: 2000 + i * 0.5,
      high: 2000 + i * 0.5 + 0.4,
      low: 2000 + i * 0.5 - 0.1,
      close: 2000 + i * 0.5 + 0.35,
    })),
    detail: '3',
  });
  createCapitalPosition.mockResolvedValue({
    ok: true,
    detail: 'filled',
    deal_reference: 'DR-1',
  });
});

describe('Pipeline authentication', () => {
  const prev: Record<string, string | undefined> = {};

  function saveEnv() {
    prev.NODE_ENV = process.env.NODE_ENV;
    prev.PIPELINE_TOKEN = process.env.PIPELINE_TOKEN;
    prev.PIPELINE_SERVICE_TOKEN = process.env.PIPELINE_SERVICE_TOKEN;
    prev.API_ADMIN_TOKEN = process.env.API_ADMIN_TOKEN;
  }
  function restoreEnv() {
    process.env.NODE_ENV = prev.NODE_ENV;
    process.env.PIPELINE_TOKEN = prev.PIPELINE_TOKEN;
    process.env.PIPELINE_SERVICE_TOKEN = prev.PIPELINE_SERVICE_TOKEN;
    process.env.API_ADMIN_TOKEN = prev.API_ADMIN_TOKEN;
  }

  it('no token → rejected when secret configured', () => {
    saveEnv();
    process.env.NODE_ENV = 'production';
    process.env.PIPELINE_TOKEN = 'pipe-secret-abc';
    delete process.env.PIPELINE_SERVICE_TOKEN;
    expect(authorizePipelineRequest({})).toBe(false);
    expect(authorizePipelineRequest({ 'x-pipeline-token': '' })).toBe(false);
    restoreEnv();
  });

  it('wrong token → rejected', () => {
    saveEnv();
    process.env.NODE_ENV = 'production';
    process.env.PIPELINE_TOKEN = 'pipe-secret-abc';
    expect(authorizePipelineRequest({ 'x-pipeline-token': 'wrong' })).toBe(false);
    expect(authorizePipelineRequest({ 'x-admin-token': 'pipe-secret-abc' })).toBe(false);
    restoreEnv();
  });

  it('correct token → accepted', () => {
    saveEnv();
    process.env.NODE_ENV = 'production';
    process.env.PIPELINE_TOKEN = 'pipe-secret-abc';
    expect(authorizePipelineRequest({ 'x-pipeline-token': 'pipe-secret-abc' })).toBe(true);
    restoreEnv();
  });

  it('production without secret → fail closed', () => {
    saveEnv();
    process.env.NODE_ENV = 'production';
    delete process.env.PIPELINE_TOKEN;
    delete process.env.PIPELINE_SERVICE_TOKEN;
    expect(authorizePipelineRequest({ 'x-pipeline-token': 'anything' })).toBe(false);
    restoreEnv();
  });

  it('rejected auth never reaches Capital (route contract)', async () => {
    saveEnv();
    process.env.NODE_ENV = 'production';
    process.env.PIPELINE_TOKEN = 'pipe-secret-abc';
    const ok = authorizePipelineRequest({ 'x-pipeline-token': 'nope' });
    expect(ok).toBe(false);
    expect(createCapitalPosition).not.toHaveBeenCalled();
    restoreEnv();
  });
});

describe('Idempotency / calc queue (no alternate Capital opener)', () => {
  it('same idempotency_key twice → ZERO Capital executions (fanout queues, robotDesk opens)', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    const r1 = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-once-1',
      explanation: 'vein long',
    });
    const r2 = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-once-1',
    });

    expect(createCapitalPosition).not.toHaveBeenCalled();
    expect(offerCalcEntry).toHaveBeenCalledTimes(1);
    expect(offerCalcEntry.mock.calls[0]?.[0]).toMatchObject({
      account_id: 170,
      epic: 'XAUUSD',
      direction: 'BUY',
      explanation: 'vein long',
    });
    expect(r1.fanout.executed[0]?.ok).toBe(true);
    expect(r1.fanout.executed[0]?.detail).toMatch(/QUEUED/);
    expect(r2.fanout.executed[0]?.detail).toMatch(/QUEUED|Duplicate|already/);
    const opened = emitToClient.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type: string }).type === 'trade_opened'
    );
    expect(opened).toHaveLength(0);
  });

  it('concurrent same key → still ZERO Capital opens (fail-closed)', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    const p1 = fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-conc-1',
    });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-conc-1',
    });
    await Promise.all([p1, p2]);

    expect(createCapitalPosition).not.toHaveBeenCalled();
  });
});

describe('Client isolation', () => {
  it('XAUUSD hits A+C only; B EURUSD skipped', () => {
    const matched = routeIntentToSubscriptions('XAUUSD', [
      { client_id: 1, epic: 'XAUUSD', running: true, lot_size: 0.1 },
      { client_id: 2, epic: 'EURUSD', running: true, lot_size: 0.05 },
      { client_id: 3, epic: 'XAUUSD', running: true, lot_size: 0.5 },
    ]);
    expect(matched.map((m) => m.client_id).sort()).toEqual([1, 3]);
    expect(matched.find((m) => m.client_id === 1)?.lot_size).toBe(0.1);
    expect(matched.find((m) => m.client_id === 3)?.lot_size).toBe(0.5);
  });
});

describe('Calc queues onto robotDesk hands', () => {
  it('pipeline EntryReady queues calc even when robot is already running — never opens Capital here', async () => {
    hasEntryEnabledRobot.mockReturnValue(true);
    offerCalcEntry.mockReturnValue({ queued: true, running: true });
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    const result = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'SELL',
      decision: 'ENTRY_READY',
      idempotency_key: 'cpp-must-not-trade',
    });

    expect(createCapitalPosition).not.toHaveBeenCalled();
    expect(offerCalcEntry).toHaveBeenCalled();
    expect(result.fanout.executed[0]?.ok).toBe(true);
    expect(result.fanout.executed[0]?.detail).toMatch(/QUEUED · robotDesk will execute calc EntryReady/);
    hasEntryEnabledRobot.mockReturnValue(false);
  });

  it('queues EntryReady onto desk START robots even with zero client-panel subscriptions', async () => {
    offerCalcEntry.mockReturnValue({ queued: true, running: true });
    listRunningHandsForEpic.mockReturnValue([{ account_id: 9, client_id: 3 }]);
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([]);

    const result = await fanoutEntryIntent({
      epic: 'GOLD',
      direction: 'SELL',
      decision: 'ENTRY_READY',
      idempotency_key: 'cpp-desk-gold-1',
    });

    expect(offerCalcEntry).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 9, epic: 'GOLD', direction: 'SELL' })
    );
    expect(result.fanout.subscribers).toBe(1);
    expect(result.fanout.executed[0]?.detail).toMatch(/QUEUED · robotDesk will execute calc EntryReady/);
  });
});

describe('Heartbeat / runtime status', () => {
  it('START + Node entry robot running (even without Market Core) → RUNNING', () => {
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: false,
        marketAnalyzed: false,
        nodeEntryRunning: true,
      }).robot_status
    ).toBe('RUNNING');
  });

  it('START while Node entry robot not yet up → STARTING, not green RUNNING', () => {
    resetPipelineBridgeForTests();
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: false,
        marketAnalyzed: false,
      }).robot_status
    ).toBe('STARTING');
  });

  it('healthy bridge, epic not yet listed, no Node robot → STARTING', () => {
    notePipelineHeartbeat(['EURUSD']);
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: true,
        marketAnalyzed: isEpicBeingAnalyzed('XAUUSD'),
      }).robot_status
    ).toBe('STARTING');
  });

  it('heartbeat restored is not enough — Node robot must be running', () => {
    notePipelineHeartbeat(['XAUUSD']);
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: getPipelineBridgeStatus().healthy,
        marketAnalyzed: isEpicBeingAnalyzed('XAUUSD'),
      }).robot_status
    ).toBe('STARTING');
  });
});

describe('UI status contract', () => {
  it('maps states for logo animation rules', () => {
    expect(computeClientRobotStatus({
      requestedRunning: false, hasAccount: true, hasEpic: true, bridgeHealthy: true, marketAnalyzed: true,
    }).robot_status).toBe('STOPPED');
    expect(computeClientRobotStatus({
      requestedRunning: true, hasAccount: true, hasEpic: true, bridgeHealthy: true, marketAnalyzed: false,
    }).robot_status).toBe('STARTING');
    expect(computeClientRobotStatus({
      requestedRunning: true, hasAccount: true, hasEpic: true, bridgeHealthy: true, marketAnalyzed: true, nodeEntryRunning: true,
    }).robot_status).toBe('RUNNING');
    expect(computeClientRobotStatus({
      requestedRunning: true, hasAccount: true, hasEpic: true, bridgeHealthy: false, marketAnalyzed: false,
    }).robot_status).toBe('STARTING');
  });
});
