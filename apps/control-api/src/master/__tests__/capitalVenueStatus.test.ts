import { afterEach, describe, expect, it } from 'vitest';
import { createCapitalBroker } from '../capitalFactory.js';
import { PaperBroker } from '../broker.js';
import { masterRuntime } from '../runtime.js';

describe('MASTER Capital epic + status venue', () => {
  afterEach(() => {
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.setEpic('GOLD');
  });

  it('attach Capital normalizes XAUUSD → GOLD', () => {
    masterRuntime.ensurePaperBroker();
    masterRuntime.setEpic('XAUUSD');
    expect(masterRuntime.epic).toBe('XAUUSD'); // paper keeps alias
    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
    });
    masterRuntime.attachBroker(broker);
    expect(masterRuntime.epic).toBe('GOLD');
  });

  it('status reports Capital venue + attach flags', () => {
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    const paper = masterRuntime.status();
    expect(paper.primary_live_venue).toBe('capital.com_api_direct');
    expect(paper.capital_live_attached).toBe(false);

    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
    });
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.persist_ok = false;
    const live = masterRuntime.status();
    expect(live.capital_live_attached).toBe(true);
    expect(live.broker).toBe('CAPITAL');
    // Before any equity tick — must not advertise LIVE_RUNNING / proven
    // Persist degrade must not mask unproven Capital account
    expect(live.capital_account_proven).toBe(false);
    expect(live.health).toBe('LIVE_ACCOUNT_UNPROVEN');
    expect(live.persist_ok).toBe(false);
    expect(live.account.day_start_equity).toBe(0);
    expect(live.account.peak_equity).toBe(0);
  });

  it('Capital attach clears paper day_start; first equity proves reseed', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.account = {
      equity: 10_000,
      balance: 10_000,
      currency: 'GBP',
      open_positions: 0,
      daily_pnl: 0,
      daily_pnl_day: new Date().toISOString().slice(0, 10),
      day_start_equity: 10_000,
      peak_equity: 10_000,
      consecutive_losses: 0,
    };
    let equity = 50_000;
    const { CapitalBroker } = await import('../broker.js');
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-day' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        market_status: 'TRADEABLE',
      }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'no' }),
      close: async () => ({ ok: false, detail: 'no' }),
      account: async () => ({
        ok: true,
        equity,
        balance: equity,
        available: equity - 1000,
        currency: 'GBP',
        detail: 'ok',
      }),
    });
    await broker.connect();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    expect(masterRuntime.account.day_start_equity).toBe(0);
    expect(masterRuntime.account.peak_equity).toBe(0);
    const st0 = masterRuntime.status();
    expect(st0.account.day_start_equity).toBe(0);
    expect(st0.capital_account_proven).toBe(false);

    const bars = Array.from({ length: 30 }, (_, i) => {
      const o = 4400 + i * 0.5;
      return {
        open: o,
        high: o + 1,
        low: o - 0.2,
        close: o + 0.4,
        ts_ms: Date.now() - (30 - i) * 60_000,
      };
    });
    const { DEFAULT_MASTER_CONFIG } = await import('../pipeline.js');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.99,
      block_off_hours: false,
    };
    masterRuntime.running = true;
    masterRuntime.persist_ok = true;
    await masterRuntime.tick(bars, {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
      market_status: 'TRADEABLE',
    });
    expect(masterRuntime.account.day_start_equity).toBe(50_000);
    expect(masterRuntime.account.peak_equity).toBe(50_000);
    expect(masterRuntime.status().capital_account_proven).toBe(true);

    equity = 47_000;
    await masterRuntime.tick(bars, {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
      market_status: 'TRADEABLE',
    });
    expect(masterRuntime.account.day_start_equity).toBe(50_000);
    expect(masterRuntime.account.equity).toBe(47_000);

    const { evaluateRisk } = await import('../risk.js');
    const { GOLD_SPEC } = await import('../pipeline.js');
    const risk = evaluateRisk(
      {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.9,
        block_reason: null,
        buy: {
          side: 'BUY',
          entry: 4410,
          stop_loss: 4400,
          take_profit: 4420,
          score: 0.9,
        } as never,
        sell: null as never,
        analysis: {
          atr: 2,
          volatility: 0.001,
          regime: 'TREND',
          market_state: 't',
        } as never,
        expectancy: null,
      } as never,
      masterRuntime.account,
      GOLD_SPEC,
      {
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      {
        ...DEFAULT_MASTER_CONFIG,
        daily_loss_limit: 2000,
        max_daily_loss_pct: 0.99,
        max_drawdown_pct: 0.99,
      }
    );
    // −£3k vs Capital day_start £50k → fires; paper £10k day_start would look like profit
    expect(risk.reasons).toContain('daily_loss_limit');
  });
});
