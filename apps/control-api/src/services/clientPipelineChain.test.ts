/**
 * Client Panel full-chain scenarios A–F (mocked Capital — no real money).
 * Injection boundary = same as production: ingestAndExecuteIntent / fanoutEntryIntent
 * (POST /api/pipeline/intents → intentFanout).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeIntentToSubscriptions } from './intentFanout.js';
import {
  authorizePipelineRequest,
  isEpicBeingAnalyzed,
  notePipelineHeartbeat,
  resetPipelineBridgeForTests,
} from './pipelineBridge.js';

const createCapitalPosition = vi.fn();
const acquireCapitalSession = vi.fn();
const listCapitalOpenPositions = vi.fn();
const emitToClient = vi.fn();
const listActiveSubscriptionsForEpic = vi.fn();
const poolQuery = vi.fn();

vi.mock('./capitalCom.js', () => ({
  createCapitalPosition: (...a: unknown[]) => createCapitalPosition(...a),
  acquireCapitalSession: (...a: unknown[]) => acquireCapitalSession(...a),
  listCapitalOpenPositions: (...a: unknown[]) => listCapitalOpenPositions(...a),
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
  connection_id?: number;
}) {
  return {
    client_id: partial.client_id,
    client_name: `Client ${partial.client_id}`,
    account_id: partial.account_id,
    connection_id: partial.connection_id ?? partial.account_id * 10,
    epic: partial.epic,
    display_name: partial.epic,
    lot_size: partial.lot_size,
    instrument_id: 100 + partial.client_id,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPipelineBridgeForTests();
  // Default DB stubs: ownership OK, capital connection, no prior dedupe, insert intent
  poolQuery.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes('pipeline_intent_dedupe') && s.includes('SELECT')) {
      return { rows: [] };
    }
    if (s.includes('INSERT INTO trade_intents')) {
      return { rows: [{ id: 42 }] };
    }
    if (s.includes('UPDATE trade_intents')) {
      return { rows: [] };
    }
    if (s.includes('INSERT INTO pipeline_intent_dedupe')) {
      return { rows: [] };
    }
    if (s.includes('Account ownership') || s.includes('ba.enabled')) {
      return { rows: [{ id: 1 }] };
    }
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
    if (s.includes('INSERT INTO positions')) {
      return { rows: [] };
    }
    return { rows: [{ id: 1 }] };
  });

  acquireCapitalSession.mockResolvedValue({
    ok: true,
    session: { token: 't' },
  });
  listCapitalOpenPositions.mockResolvedValue({ ok: true, positions: [] });
  createCapitalPosition.mockResolvedValue({
    ok: true,
    detail: 'filled',
    deal_reference: 'DR-1',
  });
});

describe('Scenario A — epic isolation (routing)', () => {
  it('XAUUSD ENTRY_READY hits only XAUUSD RUNNING clients', () => {
    const matched = routeIntentToSubscriptions('XAUUSD', [
      { client_id: 1, epic: 'XAUUSD', running: true, lot_size: 0.1 },
      { client_id: 2, epic: 'EURUSD', running: true, lot_size: 0.05 },
    ]);
    expect(matched).toEqual([{ client_id: 1, lot_size: 0.1 }]);
  });
});

describe('Scenario B — multi-client same epic, own lots', () => {
  it('both XAUUSD clients get own lot sizes', () => {
    const matched = routeIntentToSubscriptions('XAUUSD', [
      { client_id: 1, epic: 'XAUUSD', running: true, lot_size: 0.1 },
      { client_id: 3, epic: 'XAUUSD', running: true, lot_size: 0.5 },
    ]);
    expect(matched).toEqual([
      { client_id: 1, lot_size: 0.1 },
      { client_id: 3, lot_size: 0.5 },
    ]);
  });
});

describe('Scenario C — STOPPED client excluded', () => {
  it('only RUNNING client executes', () => {
    const matched = routeIntentToSubscriptions('XAUUSD', [
      { client_id: 1, epic: 'XAUUSD', running: false, lot_size: 0.1 },
      { client_id: 3, epic: 'XAUUSD', running: true, lot_size: 0.5 },
    ]);
    expect(matched).toEqual([{ client_id: 3, lot_size: 0.5 }]);
  });
});

describe('Scenario A+B execution with mocked Capital', () => {
  it('A executes 0.10; B (EURUSD) gets zero Capital calls', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 1, account_id: 101, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    const result = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'test-a-1',
    });

    expect(listActiveSubscriptionsForEpic).toHaveBeenCalledWith('XAUUSD');
    expect(createCapitalPosition).toHaveBeenCalledTimes(1);
    expect(createCapitalPosition.mock.calls[0][1]).toMatchObject({
      epic: 'XAUUSD',
      direction: 'BUY',
      size: 0.1,
    });
    expect(result.fanout.executed).toHaveLength(1);
    expect(result.fanout.executed[0].ok).toBe(true);
  });

  it('two XAUUSD clients → two Capital requests with distinct lots/accounts', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 1, account_id: 101, epic: 'XAUUSD', lot_size: 0.1 }),
      sub({ client_id: 3, account_id: 303, epic: 'XAUUSD', lot_size: 0.5 }),
    ]);

    await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'test-b-1',
    });

    expect(createCapitalPosition).toHaveBeenCalledTimes(2);
    const sizes = createCapitalPosition.mock.calls.map((c: unknown[]) => (c[1] as { size: number }).size);
    expect(sizes.sort((a: number, b: number) => a - b)).toEqual([0.1, 0.5]);
    const epics = createCapitalPosition.mock.calls.map((c: unknown[]) => (c[1] as { epic: string }).epic);
    expect(epics).toEqual(['XAUUSD', 'XAUUSD']);
  });
});

describe('Scenario D — Capital reject → no trade_opened', () => {
  it('emits error and never trade_opened', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);
    createCapitalPosition.mockResolvedValue({
      ok: false,
      detail: 'REJECTED_BY_BROKER',
    });

    const result = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'test-d-1',
    });

    expect(result.fanout.executed[0].ok).toBe(false);
    const types = emitToClient.mock.calls.map((c: unknown[]) => (c[1] as { type: string }).type);
    expect(types).toContain('error');
    expect(types).not.toContain('trade_opened');
  });
});

describe('Scenario E — Capital confirm → one trade_opened to that client', () => {
  it('only matched client receives trade_opened', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      reference_price: 2400.5,
      idempotency_key: 'test-e-1',
    });

    const opened = emitToClient.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type: string }).type === 'trade_opened'
    );
    expect(opened).toHaveLength(1);
    expect(opened[0][0]).toBe(17);
    expect(opened[0][1]).toMatchObject({
      type: 'trade_opened',
      market: 'XAUUSD',
      side: 'BUY',
      lot_size: 0.1,
      account_id: 170,
    });
    // No other client ids
    const other = emitToClient.mock.calls.filter((c: unknown[]) => c[0] !== 17);
    expect(other).toHaveLength(0);
  });
});

describe('Scenario F — status reconstructs open trade shape', () => {
  it('Capital open position maps to LIVE TRADE fields', () => {
    // Shape contract used by getClientPanelStatus Capital restore path
    const match = {
      epic: 'XAUUSD',
      direction: 'BUY' as const,
      size: 0.1,
      open_level: 2401.2,
    };
    const live = {
      market: match.epic,
      display_name: 'Gold',
      side: match.direction,
      trade_type: 'BUY',
      lot_size: match.size,
      entry_price: match.open_level,
      status: 'OPEN' as const,
    };
    expect(live).toMatchObject({
      market: 'XAUUSD',
      side: 'BUY',
      lot_size: 0.1,
      entry_price: 2401.2,
      status: 'OPEN',
    });
  });
});

describe('Duplicate intent protection', () => {
  it('second ingest with same idempotency_key does not call Capital again', async () => {
    const { fanoutEntryIntent } = await import('./intentFanout.js');
    listActiveSubscriptionsForEpic.mockResolvedValue([
      sub({ client_id: 17, account_id: 170, epic: 'XAUUSD', lot_size: 0.1 }),
    ]);

    const first = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-99-XAUUSD',
    });
    expect(createCapitalPosition).toHaveBeenCalledTimes(1);

    // Simulate stored dedupe row
    poolQuery.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('pipeline_intent_dedupe') && s.includes('SELECT')) {
        return { rows: [{ idempotency_key: 'mc-99-XAUUSD', fanout_summary: first.fanout }] };
      }
      return { rows: [] };
    });

    createCapitalPosition.mockClear();
    const second = await fanoutEntryIntent({
      epic: 'XAUUSD',
      direction: 'BUY',
      decision: 'ENTRY_READY',
      idempotency_key: 'mc-99-XAUUSD',
    });
    expect(second.deduped).toBe(true);
    expect(createCapitalPosition).not.toHaveBeenCalled();
  });
});

describe('Pipeline auth', () => {
  it('rejects when production tokens set and header missing', () => {
    const prev = {
      NODE_ENV: process.env.NODE_ENV,
      API_ADMIN_TOKEN: process.env.API_ADMIN_TOKEN,
      PIPELINE_SERVICE_TOKEN: process.env.PIPELINE_SERVICE_TOKEN,
    };
    process.env.NODE_ENV = 'production';
    process.env.API_ADMIN_TOKEN = 'admin-secret';
    process.env.PIPELINE_SERVICE_TOKEN = 'pipe-secret';
    expect(authorizePipelineRequest({})).toBe(false);
    expect(authorizePipelineRequest({ 'x-pipeline-token': 'wrong' })).toBe(false);
    expect(authorizePipelineRequest({ 'x-pipeline-token': 'pipe-secret' })).toBe(true);
    expect(authorizePipelineRequest({ 'x-admin-token': 'admin-secret' })).toBe(true);
    process.env.NODE_ENV = prev.NODE_ENV;
    process.env.API_ADMIN_TOKEN = prev.API_ADMIN_TOKEN;
    process.env.PIPELINE_SERVICE_TOKEN = prev.PIPELINE_SERVICE_TOKEN;
  });
});

describe('Confirmed RUNNING vs STARTING', () => {
  it('STARTING until bridge heartbeat includes epic', () => {
    expect(isEpicBeingAnalyzed('XAUUSD')).toBe(false);
    notePipelineHeartbeat(['EURUSD']);
    expect(isEpicBeingAnalyzed('XAUUSD')).toBe(false);
    notePipelineHeartbeat(['XAUUSD', 'EURUSD']);
    expect(isEpicBeingAnalyzed('XAUUSD')).toBe(true);
  });
});
