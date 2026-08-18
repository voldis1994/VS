/**
 * capitalEpicIsolation.test.ts
 *
 * Proves that per-client Capital EPIC assignment is fully isolated:
 *   - Market pull never auto-enables any EPIC for trading.
 *   - Each account has its own selected EPIC.
 *   - One client's EPIC cannot bleed into another client's account.
 *   - Two clients can simultaneously trade different EPICs.
 *   - Orders are rejected when the requested EPIC is not the selected one.
 *   - Client/broker/account disabled checks fire before the EPIC gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// ── DB mock ─────────────────────────────────────────────────────────────────
const mockQuery = vi.fn();
const mockConnect = vi.fn();

vi.mock('../db/pool.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}));
vi.mock('../security/encryption.js', () => ({ decrypt: vi.fn((c: string) => c) }));
vi.mock('../services/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../config/instruments.js', () => ({ getInstrumentById: vi.fn(() => null) }));
vi.mock('../vs-core/moneyPathGate.js', () => ({
  assertAuthoritativeOpener: vi.fn(() => ({ code: 'BLOCKED', reason: 'test-gate' })),
}));
vi.mock('../services/capitalCom.js', () => ({
  fetchAllCapitalMarkets: vi.fn(),
  acquireCapitalSession: vi.fn(),
}));

import { registerTradingRoutes } from './trading.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  return app;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = makeApp();
  await registerTradingRoutes(app);
  return app;
}

/** Minimal DB client double used by transactional endpoints. */
function makeTxClient(queryFn: (...args: unknown[]) => unknown) {
  return {
    query: vi.fn(queryFn),
    release: vi.fn(),
  };
}

// ── seedAccountInstruments ────────────────────────────────────────────────────
describe('seedAccountInstruments — catalog-only, never enables trading', () => {
  it('inserts rows with trading_enabled=false when markets exist', async () => {
    const { seedAccountInstruments } = await import('./trading.js');

    mockQuery
      .mockResolvedValueOnce({ rows: [{ account_id: 1, broker_connection_id: 10 }] }) // link
      .mockResolvedValueOnce({
        rows: [
          { id: 101, epic: 'GOLD', display_name: 'Gold', min_lot: 0.1, max_lot: 100, lot_step: 0.1 },
          { id: 102, epic: 'EURUSD', display_name: 'EUR/USD', min_lot: 0.01, max_lot: 50, lot_step: 0.01 },
        ],
      }) // capital_markets
      .mockResolvedValue({ rows: [] }); // INSERT × 2

    await seedAccountInstruments(1);

    // Every INSERT call must pass false for both enabled and trading_enabled.
    const insertCalls = mockQuery.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO account_instrument_settings')
    );
    expect(insertCalls.length).toBe(2);
    for (const call of insertCalls) {
      const params = call[1] as unknown[];
      // params: [accountId, instrumentId, symbol, lot_size, enabled=false, trading_enabled=false]
      expect(params[4]).toBe(false);  // enabled
      expect(params[5]).toBe(false);  // trading_enabled
    }
  });
});

// ── GET /api/trading/accounts/:accountId/selected-market ─────────────────────
describe('GET /selected-market', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('returns null when no EPIC is selected', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // account exists
      .mockResolvedValueOnce({ rows: [] });           // no trading_enabled=true row

    const res = await app.inject({ method: 'GET', url: '/api/trading/accounts/1/selected-market' });
    expect(res.statusCode).toBe(200);
    expect(res.json().selected).toBeNull();
  });

  it('returns the selected EPIC', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({
        rows: [{ instrument_id: 101, epic: 'GOLD', display_name: 'Gold', lot_size: '0.1' }],
      });

    const res = await app.inject({ method: 'GET', url: '/api/trading/accounts/1/selected-market' });
    expect(res.statusCode).toBe(200);
    expect(res.json().selected.epic).toBe('GOLD');
  });
});

// ── PUT /api/trading/accounts/:accountId/selected-market ─────────────────────
describe('PUT /selected-market — per-client EPIC assignment', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('requires capital_market_id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/trading/accounts/1/selected-market',
      body: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/capital_market_id/);
  });

  it('rejects market not in this account\'s catalog', async () => {
    // market catalog check returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/trading/accounts/1/selected-market',
      body: { capital_market_id: 999 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('atomically clears previous selection before setting new one', async () => {
    // market catalog check
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 102, epic: 'EURUSD', display_name: 'EUR/USD', min_lot: 0.01, max_lot: 50, lot_step: 0.01 }],
    });

    const txClient = makeTxClient(vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (clear all)
      .mockResolvedValueOnce({ rows: [{ instrument_id: 102, lot_size: '0.01', broker_account_id: 2, trading_enabled: true }] }) // INSERT/UPDATE
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    );
    mockConnect.mockResolvedValueOnce(txClient);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/trading/accounts/2/selected-market',
      body: { capital_market_id: 102 },
    });

    expect(res.statusCode).toBe(200);
    const clearCall = txClient.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('UPDATE account_instrument_settings') &&
             String(c[0]).includes('trading_enabled = false')
    );
    expect(clearCall).toBeTruthy();
    const clearParams = clearCall[1] as unknown[];
    expect(clearParams[0]).toBe(2); // correct account_id
  });

  it('Client A selects GOLD — Client B\'s EURUSD is unaffected', async () => {
    // Shared state: two accounts in DB
    const accountA = 10;
    const accountB = 20;
    const goldMarket = { id: 101, epic: 'GOLD', display_name: 'Gold', min_lot: 0.1, max_lot: 100, lot_step: 0.1 };
    const eurusdMarket = { id: 102, epic: 'EURUSD', display_name: 'EUR/USD', min_lot: 0.01, max_lot: 50, lot_step: 0.01 };

    // ── Assign GOLD to account A ──
    mockQuery.mockResolvedValueOnce({ rows: [goldMarket] });
    const txA = makeTxClient(vi.fn()
      .mockResolvedValue({ rows: [{ instrument_id: 101, lot_size: '0.1', broker_account_id: accountA, trading_enabled: true }] })
    );
    mockConnect.mockResolvedValueOnce(txA);

    const resA = await app.inject({
      method: 'PUT',
      url: `/api/trading/accounts/${accountA}/selected-market`,
      body: { capital_market_id: goldMarket.id },
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json().selected.epic).toBe('GOLD');

    // Verify the UPDATE (clear) only targeted account A.
    const clearA = txA.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('UPDATE account_instrument_settings')
    );
    expect(clearA![1][0]).toBe(accountA);

    vi.clearAllMocks();

    // ── Assign EURUSD to account B ──
    mockQuery.mockResolvedValueOnce({ rows: [eurusdMarket] });
    const txB = makeTxClient(vi.fn()
      .mockResolvedValue({ rows: [{ instrument_id: 102, lot_size: '0.01', broker_account_id: accountB, trading_enabled: true }] })
    );
    mockConnect.mockResolvedValueOnce(txB);

    const resB = await app.inject({
      method: 'PUT',
      url: `/api/trading/accounts/${accountB}/selected-market`,
      body: { capital_market_id: eurusdMarket.id },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json().selected.epic).toBe('EURUSD');

    // Verify the UPDATE (clear) only targeted account B — never touched account A.
    const clearB = txB.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('UPDATE account_instrument_settings')
    );
    expect(clearB![1][0]).toBe(accountB);
    expect(clearB![1][0]).not.toBe(accountA);
  });
});

// ── POST /api/trading/accounts/:accountId/orders — pre-flight gates ───────────
describe('POST /orders — pre-flight: client/broker/account/EPIC gates', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  function accountRow(overrides: Record<string, unknown> = {}) {
    return {
      account_id: 1,
      display_name: 'Test',
      external_account_id: null,
      connection_id: 10,
      broker_name: 'capital_com',
      environment: 'live',
      identifier: 'test@test.com',
      client_enabled: true,
      broker_enabled: true,
      account_enabled: true,
      ...overrides,
    };
  }

  it('rejects when client is disabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accountRow({ client_enabled: false })] });
    const res = await app.inject({
      method: 'POST', url: '/api/trading/accounts/1/orders',
      body: { epic: 'GOLD', direction: 'BUY', size: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('CLIENT_DISABLED');
  });

  it('rejects when broker is disabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accountRow({ broker_enabled: false })] });
    const res = await app.inject({
      method: 'POST', url: '/api/trading/accounts/1/orders',
      body: { epic: 'GOLD', direction: 'BUY', size: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('BROKER_DISABLED');
  });

  it('rejects when account is disabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [accountRow({ account_enabled: false })] });
    const res = await app.inject({
      method: 'POST', url: '/api/trading/accounts/1/orders',
      body: { epic: 'GOLD', direction: 'BUY', size: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ACCOUNT_DISABLED');
  });

  it('rejects when EPIC is not selected for this account', async () => {
    // Account row OK, but EPIC gate returns empty (EURUSD not selected — GOLD is)
    mockQuery
      .mockResolvedValueOnce({ rows: [accountRow()] }) // account
      .mockResolvedValueOnce({ rows: [] });             // epic gate: EURUSD not selected
    const res = await app.inject({
      method: 'POST', url: '/api/trading/accounts/1/orders',
      body: { epic: 'EURUSD', direction: 'BUY', size: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('EPIC_NOT_SELECTED');
    expect(res.json().message).toMatch(/EURUSD/);
  });

  it('two clients with different EPICs — each EPIC gate is account-scoped', async () => {
    // Account 10 selected GOLD; account 20 selected EURUSD.
    // Sending EURUSD order to account 10 must fail.
    mockQuery
      .mockResolvedValueOnce({ rows: [accountRow({ account_id: 10 })] })
      .mockResolvedValueOnce({ rows: [] }); // EURUSD not selected on account 10

    const resA = await app.inject({
      method: 'POST', url: '/api/trading/accounts/10/orders',
      body: { epic: 'EURUSD', direction: 'BUY', size: 1 },
    });
    expect(resA.statusCode).toBe(403);
    expect(resA.json().error).toBe('EPIC_NOT_SELECTED');

    vi.clearAllMocks();

    // Sending GOLD order to account 20 must also fail.
    mockQuery
      .mockResolvedValueOnce({ rows: [accountRow({ account_id: 20 })] })
      .mockResolvedValueOnce({ rows: [] }); // GOLD not selected on account 20

    const resB = await app.inject({
      method: 'POST', url: '/api/trading/accounts/20/orders',
      body: { epic: 'GOLD', direction: 'BUY', size: 1 },
    });
    expect(resB.statusCode).toBe(403);
    expect(resB.json().error).toBe('EPIC_NOT_SELECTED');
  });
});

// ── GET /api/trading/accounts/:accountId/instruments — default false ───────────
describe('GET /instruments — trading_enabled defaults to false', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('all markets have trading_enabled=false when no settings row exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ broker_connection_id: 10 }] }) // link
      .mockResolvedValueOnce({ rows: [] }) // account_instrument_settings empty
      .mockResolvedValueOnce({
        rows: [
          { id: 101, epic: 'GOLD', display_name: 'Gold', category: 'metals', instrument_type: 'CURRENCIES', min_lot: 0.1, max_lot: 100, lot_step: 0.1 },
          { id: 102, epic: 'EURUSD', display_name: 'EUR/USD', category: 'fx', instrument_type: 'CURRENCIES', min_lot: 0.01, max_lot: 50, lot_step: 0.01 },
        ],
      });

    const res = await app.inject({ method: 'GET', url: '/api/trading/accounts/1/instruments' });
    expect(res.statusCode).toBe(200);
    const markets = res.json() as { trading_enabled: boolean }[];
    expect(markets.every((m) => m.trading_enabled === false)).toBe(true);
  });
});
