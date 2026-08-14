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

vi.mock('./robotDesk.js', () => ({
  attachManageOnlyRobot: vi.fn(async () => undefined),
  listRobotSessions: () => [],
  stopRobotSession: vi.fn(async () => undefined),
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

describe('Idempotency', () => {
  it('same idempotency_key twice → exactly ONE Capital execution', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-once-1',
    });
    await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-once-1',
    });

    expect(createCapitalPosition).toHaveBeenCalledTimes(1);
    const opened = emitToClient.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type: string }).type === 'trade_opened'
    );
    expect(opened).toHaveLength(1);
  });

  it('concurrent same key → exactly ONE Capital execution', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    // Slow Capital so both enter before complete
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    createCapitalPosition.mockImplementation(async () => {
      await gate;
      return { ok: true, detail: 'filled', deal_reference: 'DR-1' };
    });

    const p1 = fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-conc-1',
    });
    // Let first claim win
    await new Promise((r) => setTimeout(r, 10));
    const p2 = fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-conc-1',
    });
    release();
    await Promise.all([p1, p2]);

    expect(createCapitalPosition).toHaveBeenCalledTimes(1);
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

describe('Heartbeat / runtime status', () => {
  it('START + healthy MC analyzing epic → RUNNING', () => {
    notePipelineHeartbeat(['XAUUSD']);
    expect(getPipelineBridgeStatus().healthy).toBe(true);
    expect(isEpicBeingAnalyzed('XAUUSD')).toBe(true);
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: true,
        marketAnalyzed: true,
      }).robot_status
    ).toBe('RUNNING');
  });

  it('START while MC unavailable → NOT RUNNING (ERROR)', () => {
    resetPipelineBridgeForTests();
    expect(getPipelineBridgeStatus().healthy).toBe(false);
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: false,
        marketAnalyzed: false,
      }).robot_status
    ).toBe('ERROR');
  });

  it('healthy bridge, epic not yet listed → STARTING', () => {
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

  it('heartbeat restored with epic → RUNNING', () => {
    notePipelineHeartbeat(['XAUUSD']);
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        bridgeHealthy: getPipelineBridgeStatus().healthy,
        marketAnalyzed: isEpicBeingAnalyzed('XAUUSD'),
      }).robot_status
    ).toBe('RUNNING');
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
      requestedRunning: true, hasAccount: true, hasEpic: true, bridgeHealthy: true, marketAnalyzed: true,
    }).robot_status).toBe('RUNNING');
    expect(computeClientRobotStatus({
      requestedRunning: true, hasAccount: true, hasEpic: true, bridgeHealthy: false, marketAnalyzed: false,
    }).robot_status).toBe('ERROR');
  });
});
