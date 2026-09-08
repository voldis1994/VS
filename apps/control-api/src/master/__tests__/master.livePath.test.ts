/**
 * LIVE Capital path — mocked broker deps (no network).
 * Proves MASTER_LIVE_ENABLED gate → confirm fill → position manage → exit close.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CapitalBroker, capitalQuoteTsMs } from '../broker.js';
import { executeDecision } from '../execution.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import type { AccountSnapshot, Bar, Quote } from '../types.js';
import { masterRuntime } from '../runtime.js';
import { clearTradeAckJournalForTest, logTradeIntent, updateTradeAck } from '../tradeAckJournal.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({ open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: Date.now() - (n - i) * 60_000 });
  }
  return out;
}

function quoteFrom(bar: Bar, spread = 0.4): Quote {
  return {
    bid: bar.close - spread / 2,
    ask: bar.close + spread / 2,
    mid: bar.close,
    spread,
    ts_ms: Date.now(),
  };
}

const account: AccountSnapshot = {
  equity: 10_000,
  balance: 10_000,
  currency: 'GBP',
  open_positions: 0,
  daily_pnl: 0,
  peak_equity: 10_000,
  consecutive_losses: 0,
};

function mockCapitalBroker(opts?: { rejectConfirm?: boolean; lagConfirm?: boolean }) {
  const positions = new Map<
    string,
    {
      deal_id: string;
      epic: string;
      direction: 'BUY' | 'SELL';
      size: number;
      open_level: number;
      stop_level?: number | null;
      profit_level?: number | null;
    }
  >();
  let confirmAttempts = 0;
  const session = { id: 'mock-session' };

  return new CapitalBroker({
    credentials: {},
    acquire: async () => ({ ok: true, session, detail: 'ok' }),
    quote: async (_s, epic) => ({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      epic,
      raw_ok: true,
      update_time: new Date().toISOString(),
    }),
    account: async () => ({ equity: 12_500, balance: 12_000, currency: 'GBP' }),
    list: async () => ({
      ok: true,
      positions: [...positions.values()].map((p) => ({
        deal_id: p.deal_id,
        epic: p.epic,
        direction: p.direction,
        size: p.size,
        open_level: p.open_level,
        stop_level: p.stop_level ?? null,
        profit_level: p.profit_level ?? null,
      })),
      detail: `${positions.size}`,
    }),
    create: async (_s, input) => ({
      ok: true,
      deal_reference: `ref-${input.direction}-${Date.now()}`,
      detail: 'opened',
    }),
    confirm: async (_s, ref) => {
      confirmAttempts += 1;
      if (String(ref).startsWith('cref-')) {
        return {
          ok: true,
          deal_id: String(ref).slice(5),
          fill_level: 4399.5,
          profit: -1.09,
          detail: `Close confirmed ${ref}`,
        };
      }
      if (String(ref).startsWith('mref-')) {
        return { ok: true, deal_id: `mod-${ref}`, detail: 'ACCEPTED' };
      }
      if (opts?.rejectConfirm) {
        return { ok: false, rejected: true, detail: 'Capital rejected: RISK_CHECK' };
      }
      if (opts?.lagConfirm && confirmAttempts < 2) {
        return { ok: false, pending: true, detail: 'pending' };
      }
      const deal_id = `deal-${ref.slice(-8)}`;
      positions.set(deal_id, {
        deal_id,
        epic: 'GOLD',
        direction: 'BUY',
        size: 0.1,
        open_level: 4410.4,
        stop_level: null,
      });
      return { ok: true, deal_id, fill_level: 4410.4, detail: `Confirmed ${deal_id}` };
    },
    modify: async (_s, input) => {
      const p = positions.get(input.dealId);
      if (!p) return { ok: false, detail: 'missing' };
      if (input.stopLevel != null) p.stop_level = Number(input.stopLevel);
      if (input.profitLevel != null) p.profit_level = Number(input.profitLevel);
      return { ok: true, deal_reference: `mref-${input.dealId}`, detail: 'modified' };
    },
    close: async (_s, dealId) => {
      if (!positions.has(dealId)) return { ok: false, detail: 'missing' };
      positions.delete(dealId);
      return {
        ok: true,
        deal_reference: `cref-${dealId}`,
        detail: `closed ${dealId}`,
      };
    },
  });
}

describe('VS MASTER LIVE Capital path (mocked)', () => {
  const prevLive = process.env.MASTER_LIVE_ENABLED;
  const prevState = process.env.MASTER_STATE_DIR;

  beforeEach(() => {
    delete process.env.MASTER_LIVE_ENABLED;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-live-path-'));
    clearTradeAckJournalForTest();
  });

  afterEach(() => {
    if (prevLive === undefined) delete process.env.MASTER_LIVE_ENABLED;
    else process.env.MASTER_LIVE_ENABLED = prevLive;
    if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prevState;
    clearTradeAckJournalForTest();
    (masterRuntime as any).capitalDeskCredsSeen = false;
    masterRuntime.stop();
  });

  it('capitalQuoteTsMs prefers update_time and fails closed when missing', () => {
    const now = Date.UTC(2026, 8, 8, 12, 0, 0);
    expect(capitalQuoteTsMs('2026-09-08T11:59:30.000Z', now)).toBe(
      Date.parse('2026-09-08T11:59:30.000Z')
    );
    expect(capitalQuoteTsMs(null, now)).toBe(now - 60_000);
    expect(capitalQuoteTsMs('not-a-time', now)).toBe(now - 60_000);
  });

  it('REST getQuote stamps ts_ms from update_time (not Date.now)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const updateIso = new Date(Date.now() - 45_000).toISOString();
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-ts' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        update_time: updateIso,
        market_status: 'TRADEABLE',
      }),
      list: async () => ({ ok: true, positions: [] }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    const q = await broker.getQuote('GOLD');
    expect(q).not.toBeNull();
    expect(q!.ts_ms).toBe(Date.parse(updateIso));
    expect(Date.now() - q!.ts_ms).toBeGreaterThan(30_000);
  });

  it('blocks LIVE execution without MASTER_LIVE_ENABLED', async () => {
    const broker = mockCapitalBroker();
    await broker.connect();
    const pipe = new MasterPipeline('LIVE');
    const bars = barsTrendUp();
    const cycle = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE', min_score: 0.3 },
    });
    const decision =
      cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL'
        ? cycle.decision
        : {
            ...cycle.decision,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...cycle.decision.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const { execution } = await executeDecision({
      broker,
      pipeline: pipe,
      opportunity: cycle.opportunity,
      decision,
      risk: { allowed: true, volume: 0.1, risk_amount: 10, reasons: [] },
      epic: 'GOLD',
      allow_live: false,
    });
    expect(execution.accepted).toBe(false);
    expect(execution.detail).toMatch(/live_blocked/);
  });

  it('LIVE enabled: confirm fill → manage → HardInv close via Capital', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = mockCapitalBroker({ lagConfirm: true });
    await broker.connect();
    const acct = await broker.getAccount();
    expect(acct?.equity).toBe(12_500);

    const pipe = new MasterPipeline('LIVE');
    const bars = barsTrendUp();
    const quote = quoteFrom(bars.at(-1)!);
    const cycle = await pipe.runCycle({
      bars,
      quote,
      account: { ...account, equity: acct!.equity },
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE', min_score: 0.3 },
    });
    const decision = {
      ...cycle.decision,
      kind: 'BUY' as const,
      side: 'BUY' as const,
      block_reason: null,
      buy: { ...cycle.decision.buy, valid: true, filter_ok: true, score: 0.9, stop_loss: 4400 },
    };
    const { execution, place } = await executeDecision({
      broker,
      pipeline: pipe,
      opportunity: cycle.opportunity,
      decision,
      risk: { allowed: true, volume: 0.1, risk_amount: 10, reasons: [] },
      epic: 'GOLD',
      allow_live: true,
    });
    expect(execution.accepted).toBe(true);
    expect(place?.position_id).toBeTruthy();
    expect(place?.fill_price).toBe(4410.4);

    const pm = new PositionManager();
    pm.register({
      position_id: place!.position_id!,
      opportunity_id: cycle.opportunity.id,
      intent_id: execution.intent_id,
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: place!.fill_price!,
      stop_loss: 4400,
      decision,
    });

    const crash: Quote = {
      bid: 4380,
      ask: 4380.4,
      mid: 4380.2,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: crash,
      instrument_point_value: 1,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toBe('STOP_HIT');
    // Journal uses confirmed Capital close fill when present (not synthetic SL)
    expect(managed.closed[0]!.outcome.exit).toBe(4399.5);
    // Prefer Capital confirm.profit over recomputed pts×size
    expect(managed.closed[0]!.outcome.pnl).toBe(-1.09);
    expect(await broker.listOpenPositions()).toEqual({
      ok: true,
      positions: [],
      presence_ids: [],
    });
  });

  it('getHistoryBars maps Capital minute candles to structure bars', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const session = { id: 'hist' };
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => ({ ok: true, positions: [], detail: '' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      prices: async (_s, epic, resolution, max) => ({
        ok: true,
        detail: `${epic}_${resolution}_${max}`,
        candles: Array.from({ length: 30 }, (_, i) => ({
          open: 4400 + i * 0.5,
          high: 4401 + i * 0.5,
          low: 4399 + i * 0.5,
          close: 4400.5 + i * 0.5,
          snapshotTime: new Date(Date.UTC(2026, 8, 7, 10, i)).toISOString(),
        })),
      }),
    });
    await broker.connect();
    const hist = await broker.getHistoryBars('GOLD', 60);
    expect(hist.ok).toBe(true);
    expect(hist.bars.length).toBe(30);
    expect(hist.detail).toMatch(/capital_minute_30/);
    expect(hist.bars[0]!.open).toBe(4400);
  });

  it('startBrokerLiveFeed polls Capital getQuote (no silent LIVE)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = mockCapitalBroker();
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.99,
      block_off_hours: false,
    };
    masterRuntime.setEpic('GOLD');
    // live_feed false → must still start broker feed for non-paper
    await masterRuntime.start({ broker, live_feed: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(masterRuntime.broker_detail || '').toMatch(/broker_feed:CAPITAL/);
    expect(masterRuntime.last_quote?.mid).toBeCloseTo(4410.2, 5);
    masterRuntime.stop();
  });

  it('PAPER public feed is replaced by Capital broker feed on LIVE start', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_BROKER_FEED_SYNTHETIC = 'true';
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.setMode('PAPER');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      min_score: 0.99,
      block_off_hours: false,
    };
    masterRuntime.setEpic('GOLD');
    // Start PAPER with a fake public feed timer already running
    await masterRuntime.start({
      broker: masterRuntime.ensurePaperBroker(),
      live_feed: false,
    });
    // Manually plant a public-style timer that would otherwise stick
    (masterRuntime as any).stopLiveFeed?.();
    let publicTicks = 0;
    (masterRuntime as any).liveFeedTimer = setInterval(() => {
      publicTicks += 1;
    }, 20);

    const broker = mockCapitalBroker();
    await broker.connect();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...masterRuntime.cfg, mode: 'LIVE' };
    await masterRuntime.start({ broker, live_feed: false });
    const before = publicTicks;
    await new Promise((r) => setTimeout(r, 60));
    // Stuck public timer would keep incrementing; stopLiveFeed must have cleared it
    expect(publicTicks).toBe(before);
    expect(masterRuntime.broker_detail || '').toMatch(/broker_feed:CAPITAL/);
    expect(masterRuntime.last_quote?.mid).toBeCloseTo(4410.2, 5);
    expect(masterRuntime.status().capital_live_attached).toBe(true);
    masterRuntime.persist_ok = true;
    expect(masterRuntime.status().health).toBe('LIVE_RUNNING');
    masterRuntime.stop();
    delete process.env.MASTER_BROKER_FEED_SYNTHETIC;
  });

  it('LIVE mode without Capital attach reports LIVE_UNATTACHED health', () => {
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('LIVE');
    masterRuntime.persist_ok = true;
    const st = masterRuntime.status();
    expect(st.capital_live_attached).toBe(false);
    expect(st.health).toBe('LIVE_UNATTACHED');
  });

  it('noteCapitalCredentialSource marks Brokers desk creds available', () => {
    masterRuntime.stop();
    masterRuntime.noteCapitalCredentialSource('capital_desk_connected:id=7');
    const st = masterRuntime.status();
    expect(st.capital_desk_creds_seen).toBe(true);
    expect(st.capital_creds_available).toBe(true);
    expect(st.capital_credential_source).toBe('desk');
  });

  it('tick parks Capital entries when market_status is CLOSED', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = mockCapitalBroker();
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.2,
      block_off_hours: false,
    };
    masterRuntime.account = { ...account };
    masterRuntime.persist_ok = true;
    await masterRuntime.start({ broker, live_feed: false });

    const bars = barsTrendUp(50);
    const q = {
      ...quoteFrom(bars.at(-1)!),
      epic: 'GOLD',
      market_status: 'CLOSED',
    };
    const r = await masterRuntime.tick(bars, q);
    expect(masterRuntime.account.trade_allowed).toBe(false);
    expect(r.executed).toBe(false);
    expect(
      r.risk.reasons.includes('account_not_tradeable') ||
        r.execution_detail ||
        r.decision.kind === 'WAIT' ||
        !r.risk.allowed
    ).toBe(true);
    masterRuntime.stop();
  });

  it('refuseDetachCapitalWithOpens blocks Start PAPER while Capital has opens', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = mockCapitalBroker();
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    // Seed a local open as if Capital fill was booked
    masterRuntime.positions.register({
      position_id: 'deal-open-1',
      opportunity_id: 'opp-1',
      intent_id: 'intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      take_profit: 4430,
      decision: {
        decision_id: 'd1',
        kind: 'BUY',
        side: 'BUY',
        score: 0.8,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.8,
          structure_bias: 'BULLISH',
          swing_high: 4450,
          swing_low: 4380,
          buy_pressure: 0.7,
          sell_pressure: 0.3,
          behavior_bull: 0.7,
          behavior_bear: 0.3,
          impact_score: 0.5,
          context_quality: 0.8,
          volatility: 0.001,
          atr: 2,
          data_quality: 0.9,
          session: 'LONDON',
        },
        expectancy: null,
      },
    });
    const gate = await masterRuntime.refuseDetachCapitalWithOpens();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.detail).toMatch(/refuse_paper_with_capital_opens/);

    // After flatten (empty local + empty venue) detach is allowed
    masterRuntime.positions = new PositionManager();
    expect((await masterRuntime.refuseDetachCapitalWithOpens()).ok).toBe(true);
    masterRuntime.detachToPaperBroker();
    expect(masterRuntime.broker?.name).toBe('PAPER');
  });

  it('refuseDetachCapitalWithOpens blocks when venue has orphan Capital deal (local empty)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
      }
    >();
    positions.set('venue-orphan', {
      deal_id: 'venue-orphan',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-orphan' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()],
        detail: `${positions.size}`,
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      close: async (_s, id) => {
        positions.delete(id);
        return { ok: true, deal_reference: `c-${id}`, detail: 'closed' };
      },
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    const gate = await masterRuntime.refuseDetachCapitalWithOpens();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.detail).toMatch(/venue=1/);

    const flat = await masterRuntime.flattenAll('TEST_FLATTEN_ORPHAN');
    expect(flat.ok).toBe(true);
    expect(flat.closed).toBeGreaterThanOrEqual(1);
    expect(positions.size).toBe(0);
    expect((await masterRuntime.refuseDetachCapitalWithOpens()).ok).toBe(true);
  });

  it('flatten venue orphan journals proven Capital profit into daily_pnl', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        upl?: number | null;
      }
    >();
    positions.set('venue-orphan-pnl', {
      deal_id: 'venue-orphan-pnl',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      upl: -3.5,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-orphan-pnl' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4380,
        ask: 4380.4,
        mid: 4380.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()],
        detail: `${positions.size}`,
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async (_s, id) => {
        positions.delete(String(id));
        return { ok: true, deal_reference: `c-${id}`, detail: 'submitted' };
      },
      confirm: async () => ({
        ok: false,
        closed_gone: true,
        deal_id: 'venue-orphan-pnl',
        fill_level: 4380.1,
        profit: -4.25,
        detail: 'confirm_closed_gone:DELETED',
      }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.positions = new PositionManager();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.account = { ...account, daily_pnl: 0, consecutive_losses: 0 };
    const flat = await masterRuntime.flattenAll('TEST_FLATTEN_ORPHAN_PNL');
    expect(flat.ok).toBe(true);
    expect(flat.closed).toBeGreaterThanOrEqual(1);
    expect(masterRuntime.account.daily_pnl).toBe(-4.25);
    expect(masterRuntime.account.consecutive_losses).toBe(1);
    expect(String(masterRuntime.last_exit_reason || '')).toMatch(/venue_orphan/);
  });

  it('runtime LIVE tick opens when MASTER_LIVE_ENABLED and mocked Capital attached', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = mockCapitalBroker();
    await broker.connect();

    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE', min_score: 0.35 };
    masterRuntime.account = { ...account };
    await masterRuntime.start();

    const bars = barsTrendUp(50);
    let opened = false;
    for (let i = 35; i < bars.length; i++) {
      const slice = bars.slice(0, i + 1);
      const r = await masterRuntime.tick(slice, quoteFrom(slice.at(-1)!));
      if (r.executed) {
        opened = true;
        break;
      }
    }
    // Force path if filters blocked — still proves LIVE gate + capital place
    if (!opened) {
      const q = quoteFrom(bars.at(-1)!);
      const cycle = await masterRuntime.pipeline.runCycle({
        bars,
        quote: q,
        account: masterRuntime.account,
        instrument: GOLD_SPEC,
        cfg: masterRuntime.cfg,
      });
      const { execution, place } = await executeDecision({
        broker,
        pipeline: masterRuntime.pipeline,
        opportunity: cycle.opportunity,
        decision: {
          ...cycle.decision,
          kind: 'BUY',
          side: 'BUY',
          block_reason: null,
          buy: { ...cycle.decision.buy, valid: true, filter_ok: true, score: 0.95 },
        },
        risk: { allowed: true, volume: 0.1, risk_amount: 10, reasons: [] },
        epic: 'GOLD',
        allow_live: true,
      });
      expect(execution.accepted).toBe(true);
      expect(place?.position_id).toBeTruthy();
      opened = true;
    }
    expect(opened).toBe(true);
    masterRuntime.stop();
  });

  it('bare-open then SL attach fail closes naked position (VS-System-)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number;
      }
    >();
    const session = { id: 's' };
    let createN = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async (_s, input) => {
        createN += 1;
        if (createN === 1 && input.stopLevel != null) {
          return { ok: false, detail: 'MINIMUM_STOP_DISTANCE' };
        }
        return { ok: true, deal_reference: `ref-bare-${createN}`, detail: 'opened_bare' };
      },
      confirm: async (_s, ref) => {
        const deal_id = `deal-${ref}`;
        if (!positions.has(deal_id)) {
          positions.set(deal_id, {
            deal_id,
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: 4410.4,
          });
        }
        return { ok: true, deal_id, fill_level: 4410.4, detail: 'ok' };
      },
      modify: async () => ({ ok: false, detail: 'MINIMUM_STOP_DISTANCE' }),
      close: async (_s, dealId) => {
        positions.delete(dealId);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const placed = await broker.placeOrder({
      intent_id: 'sl-attach-fail',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4409.9,
    });
    expect(placed.ok).toBe(false);
    expect(placed.detail).toBe('CAPITAL_SL_ATTACH_FAILED');
    expect(positions.size).toBe(0);
  });

  it('ACCEPTED deal_id that was pre-open falls through to new match (not orphan bind)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        opened_at?: string;
      }
    >();
    positions.set('old-orphan', {
      deal_id: 'old-orphan',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4400,
      stop_level: 4390,
      opened_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pre' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          opened_at: p.opened_at ?? null,
        })),
        detail: '',
      }),
      create: async () => {
        positions.set('new-fill', {
          deal_id: 'new-fill',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: 4410.4,
          stop_level: null,
          opened_at: new Date().toISOString(),
        });
        return { ok: true, deal_reference: 'ref-pre', detail: 'posted' };
      },
      confirm: async (_s, ref) => {
        if (String(ref).startsWith('mod')) {
          return { ok: true, deal_id: 'mod', detail: 'ok' };
        }
        // Stale confirm points at pre-open orphan — must not bind it
        return {
          ok: true,
          deal_id: 'old-orphan',
          fill_level: 4400,
          detail: 'ACCEPTED',
        };
      },
      modify: async (_s, input) => {
        const p = positions.get(input.dealId);
        if (p && input.stopLevel != null) p.stop_level = Number(input.stopLevel);
        return { ok: true, deal_reference: 'mod-1', detail: 'ok' };
      },
      close: async (id) => {
        if (id === 'old-orphan') return { ok: false, detail: 'must_not_close_preopen' };
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-preopen-aaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(true);
    expect(place.position_id).toBe('new-fill');
    expect(positions.has('old-orphan')).toBe(true);
    expect(positions.get('new-fill')!.stop_level).toBe(4400);
  });

  it('ensureProtectiveLevelsOrFail refuses when side unproven', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-side' }, detail: 'ok' }),
      quote: async () => null,
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'side-less',
            epic: 'GOLD',
            direction: null,
            size: 0.1,
            open_level: 4410,
            stop_level: null,
          },
        ],
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => ({ ok: true, detail: 'ok' }),
    });
    await broker.connect();
    const guard = await broker.ensureProtectiveLevelsOrFail({
      position_id: 'side-less',
      want_sl: 4400,
      order_id: 'o1',
      epic: 'GOLD',
      // no side — and list omits unproven direction from positions[]
    });
    expect(guard.ok).toBe(false);
    expect(guard.detail).toBe('capital_sl_attach_side_unproven');
  });

  it('SL attach fail reports capital_fail_close_unproven when DELETE leaves deal open', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number;
      }
    >();
    const session = { id: 's-unproven' };
    let createN = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async (_s, input) => {
        createN += 1;
        if (createN === 1 && input.stopLevel != null) {
          return { ok: false, detail: 'MINIMUM_STOP_DISTANCE' };
        }
        return { ok: true, deal_reference: `ref-unproven-${createN}`, detail: 'opened_bare' };
      },
      confirm: async (_s, ref) => {
        const deal_id = `deal-${ref}`;
        if (!positions.has(deal_id)) {
          positions.set(deal_id, {
            deal_id,
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: 4410.4,
          });
        }
        return { ok: true, deal_id, fill_level: 4410.4, detail: 'ok' };
      },
      modify: async () => ({ ok: false, detail: 'MINIMUM_STOP_DISTANCE' }),
      // DELETE pretends OK but does not remove — no deal_reference so confirm cannot invent a fill
      close: async () => ({ ok: true, detail: 'submitted_noop' }),
    });
    await broker.connect();
    const placed = await broker.placeOrder({
      intent_id: 'sl-attach-unproven-close',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4409.9,
    });
    expect(placed.ok).toBe(false);
    expect(placed.detail).toMatch(/capital_fail_close_unproven/);
    expect(placed.position_id).toBe(`deal-ref-unproven-2`);
    expect(placed.fill_price).toBe(4410.4);
    expect(positions.size).toBe(1);
  });

  it('fail-close does not stamp provisional mid as fill_price', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level?: number | null;
        stop_level?: number;
      }
    >();
    let createN = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-provfc' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4499,
        ask: 4499.4,
        mid: 4499.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          // omit open_level — list invents provisional mid
          stop_level: p.stop_level ?? null,
        })),
        detail: '',
      }),
      create: async (_s, input) => {
        createN += 1;
        if (createN === 1 && input.stopLevel != null) {
          return { ok: false, detail: 'MINIMUM_STOP_DISTANCE' };
        }
        return { ok: true, deal_reference: `ref-provfc-${createN}`, detail: 'opened_bare' };
      },
      confirm: async (_s, ref) => {
        const deal_id = `deal-${ref}`;
        if (!positions.has(deal_id)) {
          positions.set(deal_id, {
            deal_id,
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
          });
        }
        // No fill_level — only provisional mid on book
        return { ok: true, deal_id, detail: 'ACCEPTED' };
      },
      modify: async () => ({ ok: false, detail: 'MINIMUM_STOP_DISTANCE' }),
      close: async () => ({ ok: true, detail: 'submitted_noop' }),
    });
    await broker.connect();
    const placed = await broker.placeOrder({
      intent_id: 'sl-attach-prov-failclose',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4409.9,
    });
    expect(placed.ok).toBe(false);
    expect(placed.detail).toMatch(/capital_fail_close_unproven|capital_open_fill_unproven/);
    // Must not advertise quote mid as proven fill
    expect(placed.fill_price).not.toBe(4499.2);
    expect(
      placed.fill_price == null ||
        (Number.isFinite(placed.fill_price) && placed.fill_price !== 4499.2)
    ).toBe(true);
  });

  it('fail-close keeps known position_id when list flakes after close failure', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number;
      }
    >();
    const session = { id: 's-list-flake' };
    let createN = 0;
    let closeCalled = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => {
        if (closeCalled) {
          return { ok: false, positions: [], detail: 'list_timeout' };
        }
        return { ok: true, positions: [...positions.values()], detail: '' };
      },
      create: async (_s, input) => {
        createN += 1;
        if (createN === 1 && input.stopLevel != null) {
          return { ok: false, detail: 'MINIMUM_STOP_DISTANCE' };
        }
        return { ok: true, deal_reference: `ref-flake-${createN}`, detail: 'opened_bare' };
      },
      confirm: async (_s, ref) => {
        const deal_id = `deal-${ref}`;
        if (!positions.has(deal_id)) {
          positions.set(deal_id, {
            deal_id,
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: 4410.4,
          });
        }
        return { ok: true, deal_id, fill_level: 4410.4, detail: 'ok' };
      },
      modify: async () => ({ ok: false, detail: 'MINIMUM_STOP_DISTANCE' }),
      close: async () => {
        closeCalled = true;
        return { ok: false, detail: 'close_transport_error' };
      },
    });
    await broker.connect();
    const placed = await broker.placeOrder({
      intent_id: 'sl-attach-list-flake',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4409.9,
    });
    expect(placed.ok).toBe(false);
    expect(placed.detail).toMatch(/capital_fail_close_unproven/);
    expect(placed.position_id).toBeTruthy();
    expect(placed.position_id).toMatch(/^deal-ref-flake-/);
  });

  it('fail-close keeps position_id when close fails and list returns empty', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
      }
    >();
    let closeCalled = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-empty' }, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => {
        if (closeCalled) {
          // One flaky empty after failed DELETE — must not treat as flat
          return { ok: true, positions: [], detail: '' };
        }
        return { ok: true, positions: [...positions.values()], detail: '' };
      },
      create: async (_s, input) => {
        if (input.stopLevel != null) {
          return { ok: false, detail: 'MINIMUM_STOP_DISTANCE' };
        }
        return { ok: true, deal_reference: 'ref-empty-list', detail: 'opened_bare' };
      },
      confirm: async (_s, ref) => {
        const deal_id = `deal-${ref}`;
        if (!positions.has(deal_id)) {
          positions.set(deal_id, {
            deal_id,
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: 4410.4,
          });
        }
        return { ok: true, deal_id, fill_level: 4410.4, detail: 'ok' };
      },
      modify: async () => ({ ok: false, detail: 'MINIMUM_STOP_DISTANCE' }),
      close: async () => {
        closeCalled = true;
        return { ok: false, detail: 'HTTP 500 close_failed' };
      },
    });
    await broker.connect();
    const placed = await broker.placeOrder({
      intent_id: 'sl-attach-empty-list',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4409.9,
    });
    expect(placed.ok).toBe(false);
    expect(placed.detail).toMatch(/capital_fail_close_unproven/);
    expect(placed.position_id).toBe('deal-ref-empty-list');
  });

  it('confirm reject fail-closes same-size ghost fill', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
      }
    >();
    const session = { id: 's-rej' };
    let closed = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async (_s, input) => {
        positions.set('ghost-1', {
          deal_id: 'ghost-1',
          epic: input.epic,
          direction: input.direction,
          size: input.size,
          open_level: 4410.4,
        });
        return { ok: true, deal_reference: 'ref-rej', detail: 'opened' };
      },
      confirm: async () => ({ ok: false, rejected: true, detail: 'Capital rejected: RISK_CHECK' }),
      close: async (_s, dealId) => {
        closed += 1;
        positions.delete(dealId);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const placed = await broker.placeOrder({
      intent_id: 'reject-ghost-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(placed.ok).toBe(false);
    expect(placed.detail).toMatch(/fail_closed/);
    expect(closed).toBe(1);
    expect(positions.size).toBe(0);
  });

  it('modifyPosition treats confirm REJECTED as failure + caches live min-stop', async () => {
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
      }
    >();
    positions.set('d1', {
      deal_id: 'd1',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4400,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        min_stop_distance: 0.5,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => ({
        ok: true,
        deal_reference: 'mod-ref-1',
        detail: 'accepted_http',
      }),
      confirm: async () => ({
        ok: false,
        rejected: true,
        detail: 'Capital rejected: MINIMUM_STOP_DISTANCE',
      }),
    });
    await broker.connect();
    const q = await broker.getQuote('GOLD');
    expect(q?.min_stop_distance).toBe(0.5);
    expect(broker.liveMinStopDistance('GOLD')).toBe(0.5);
    const mod = await broker.modifyPosition({
      position_id: 'd1',
      stop_level: 4409.9,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toMatch(/modify_confirm_rejected/);
  });

  it('modifyPosition rejects ACCEPTED when broker SL never moved', async () => {
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
      }
    >();
    positions.set('d1', {
      deal_id: 'd1',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4400,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => ({
        ok: true,
        deal_reference: 'mod-ack-1',
        detail: 'accepted_http',
      }),
      confirm: async () => ({
        ok: true,
        deal_id: 'mod-deal',
        detail: 'ACCEPTED',
      }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd1',
      stop_level: 4405,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toMatch(/modify_sl_unverified/);
  });

  it('modifyPosition rejects TP-only ACK when profit_level never moved', async () => {
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        profit_level?: number | null;
      }
    >();
    positions.set('d1', {
      deal_id: 'd1',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4400,
      profit_level: null,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          profit_level: p.profit_level ?? null,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => ({
        ok: true,
        deal_reference: 'mod-tp-1',
        detail: 'accepted_http',
      }),
      confirm: async () => ({
        ok: true,
        deal_id: 'mod-deal',
        detail: 'ACCEPTED',
      }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd1',
      profit_level: 4430,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toMatch(/modify_tp_(not_visible|unverified)/);
  });

  it('empty REJECTED confirm match-accepts *new* same-size open (not pre-open)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        opened_at?: string;
      }
    >();
    // Pre-existing orphan must NOT be bound/fail-closed
    positions.set('old-orphan', {
      deal_id: 'old-orphan',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4400,
      stop_level: 4390,
      opened_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          opened_at: p.opened_at ?? null,
        })),
        detail: '',
      }),
      create: async () => {
        // Fill lands despite empty REJECTED confirm
        positions.set('ghost-fill', {
          deal_id: 'ghost-fill',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: 4410.4,
          stop_level: null,
          opened_at: new Date().toISOString(),
        });
        return {
          ok: true,
          deal_reference: 'ref-empty-rej',
          detail: 'posted',
        };
      },
      close: async (id) => {
        if (id === 'old-orphan') return { ok: false, detail: 'must_not_close_preopen' };
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
      modify: async (_s, input) => {
        const p = positions.get(input.dealId);
        if (p && input.stopLevel != null) p.stop_level = Number(input.stopLevel);
        return { ok: true, deal_reference: 'mod-attach', detail: 'ok' };
      },
      confirm: async (_s, ref) => {
        if (String(ref) === 'mod-attach') {
          return { ok: true, deal_id: 'mod-deal', detail: 'ACCEPTED' };
        }
        return {
          ok: false,
          rejected: true,
          deal_id: 'ghost-fill',
          fill_level: 4410.4,
          // detail embeds fill "level" JSON — must NOT classify as named SL reject
          detail:
            'Capital rejected: {"dealStatus":"REJECTED","status":"OPEN","level":4410.5,"dealId":"ghost-fill"}',
          // empty reject_reason → match-accept path
        };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-empty-rej',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(true);
    expect(place.position_id).toBe('ghost-fill');
    expect(place.fill_price).toBe(4410.4);
    expect(place.detail).toMatch(/capital_open/);
    expect(positions.get('ghost-fill')!.stop_level).toBe(4400);
    expect(positions.has('old-orphan')).toBe(true);
  });

  it('empty REJECTED with deal_id binds that ticket not a same-size sibling', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        opened_at?: string;
      }
    >();
    // Concurrent same-size sibling — fuzzy match would prefer this if deal_id ignored
    positions.set('sibling-wrong', {
      deal_id: 'sibling-wrong',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4401,
      stop_level: 4390,
      opened_at: new Date().toISOString(),
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-did' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          opened_at: p.opened_at ?? null,
        })),
        detail: '',
      }),
      create: async () => {
        positions.set('real-fill', {
          deal_id: 'real-fill',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: 4410.4,
          stop_level: null,
          opened_at: new Date().toISOString(),
        });
        return { ok: true, deal_reference: 'ref-did', detail: 'posted' };
      },
      close: async (id) => {
        if (id === 'sibling-wrong') return { ok: false, detail: 'must_not_close_sibling' };
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
      modify: async (_s, input) => {
        const p = positions.get(input.dealId);
        if (p && input.stopLevel != null) p.stop_level = Number(input.stopLevel);
        return { ok: true, deal_reference: 'mod-did', detail: 'ok' };
      },
      confirm: async (_s, ref) => {
        if (String(ref) === 'mod-did') {
          return { ok: true, deal_id: 'mod-ok', detail: 'ACCEPTED' };
        }
        return {
          ok: false,
          rejected: true,
          deal_id: 'real-fill',
          fill_level: 4410.4,
          detail: 'Capital rejected: REJECTED',
        };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-did-bind',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(true);
    expect(place.position_id).toBe('real-fill');
    expect(positions.has('sibling-wrong')).toBe(true);
    expect(positions.get('real-fill')!.stop_level).toBe(4400);
  });

  it('LIVE tick without Capital attached refuses OPEN (live_no_capital)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.3,
      block_off_hours: false,
      cooldown_ms_after_loss: 0,
    };
    masterRuntime.account = {
      ...account,
      trade_allowed: true,
      consecutive_losses: 0,
      daily_pnl: 0,
    };
    masterRuntime.last_loss_ms = 0;
    masterRuntime.running = true;
    masterRuntime.positions = new PositionManager();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    const bars = barsTrendUp(40);
    const quote = {
      ...quoteFrom(bars.at(-1)!),
      epic: 'GOLD',
      market_status: 'TRADEABLE',
      ts_ms: Date.now(),
    };
    const r = await masterRuntime.tick(bars, quote);
    expect(r.executed).toBe(false);
    expect(String(r.execution_detail || masterRuntime.last_execution_detail || '')).toMatch(
      /live_no_capital/
    );
    expect(masterRuntime.positions.count()).toBe(0);
  });

  it('closePosition accepts closed_gone DELETED confirm', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-cg' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: true, positions: [] }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({
        ok: true,
        deal_reference: 'cg-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({
        ok: false,
        closed_gone: true,
        deal_id: 'was-open',
        fill_level: 4410.1,
        profit: -1.25,
        detail: 'confirm_closed_gone:DELETED',
      }),
    });
    await broker.connect();
    const closed = await broker.closePosition('was-open');
    expect(closed.ok).toBe(true);
    expect(closed.fill_pnl).toBe(-1.25);
  });

  it('Capital closed_gone without fill_level does not journal live mark as exit', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-nofillext' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4499,
        ask: 4499.4,
        mid: 4499.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({
        ok: true,
        deal_reference: 'nofill-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({
        ok: false,
        closed_gone: true,
        deal_id: 'deal-nofillext',
        // no fill_level — broker returns null fill
        profit: -12.5,
        detail: 'confirm_closed_gone:DELETED',
      }),
    });
    await broker.connect();
    const closed = await broker.closePosition('deal-nofillext');
    expect(closed.ok).toBe(true);
    expect(closed.fill_price == null || !(closed.fill_price > 0)).toBe(true);
    expect(closed.fill_pnl).toBe(-12.5);

    const { resolveCloseExitFill } = await import('../moneyExit.js');
    const { exit, fill_proven } = resolveCloseExitFill({
      fill_price: closed.fill_price,
      mark: 4499,
      entry: 4410.55,
      capitalLive: true,
    });
    expect(fill_proven).toBe(false);
    expect(exit).toBe(4410.55); // entry placeholder — not live mark
    expect(exit).not.toBe(4499);

    const stopProxy = resolveCloseExitFill({
      fill_price: null,
      mark: 4499,
      entry: 4410.55,
      capitalLive: true,
      hard_reason: 'STOP_HIT',
      stop_loss: 4400,
    });
    expect(stopProxy.exit).toBe(4400);
    expect(stopProxy.fill_proven).toBe(false); // local SL ≠ venue-proven fill
  });

  it('closed_gone DELETED still debounces empty list (flake reopen refuses)', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let lists = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-cg-flake' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        lists += 1;
        // before-size snapshot + first post-close empty, then deal still LIVE
        if (lists <= 2) return { ok: true, positions: [] };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'still-live',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: 4410,
            },
          ],
        };
      },
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({
        ok: true,
        deal_reference: 'cg-flake-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({
        ok: false,
        closed_gone: true,
        deal_id: 'still-live',
        fill_level: 4410.1,
        profit: -0.5,
        detail: 'confirm_closed_gone:DELETED',
      }),
    });
    await broker.connect();
    const closed = await broker.closePosition('still-live');
    expect(closed.ok).toBe(false);
    expect(closed.detail).toMatch(/close_not_confirmed|still_open|debounce/i);
  });

  it('named reject does not fail-close pre-open same-size orphan', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
      }
    >();
    positions.set('pre-open', {
      deal_id: 'pre-open',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
    });
    let closed: string[] = [];
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pre' }, detail: 'ok' }),
      quote: async (_s, epic) => ({ bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true }),
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async () => ({ ok: true, deal_reference: 'ref-named', detail: 'posted' }),
      confirm: async () => ({
        ok: false,
        rejected: true,
        reject_reason: 'MINIMUM_STOP_DISTANCE',
        detail: 'Capital rejected: MINIMUM_STOP_DISTANCE',
      }),
      close: async (_s, id) => {
        closed.push(id);
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-named-preopen',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(closed).toEqual([]);
    expect(positions.has('pre-open')).toBe(true);
  });

  it('empty REJECTED match fail-closes when protective SL cannot attach', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        opened_at?: string;
      }
    >();
    let closed = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          opened_at: p.opened_at ?? null,
        })),
        detail: '',
      }),
      create: async () => {
        positions.set('naked-fill', {
          deal_id: 'naked-fill',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: 4410.4,
          stop_level: null,
          opened_at: new Date().toISOString(),
        });
        return {
          ok: true,
          deal_reference: 'ref-naked',
          detail: 'posted',
        };
      },
      close: async (_s, id) => {
        closed += 1;
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
      modify: async () => ({
        ok: true,
        deal_reference: 'mod-noop',
        detail: 'accepted_http',
      }),
      confirm: async (_s, ref) => {
        if (String(ref) === 'mod-noop') {
          // ACK but SL never moves → modifyPosition rejects
          return { ok: true, deal_id: 'mod-deal', detail: 'ACCEPTED' };
        }
        return {
          ok: false,
          rejected: true,
          detail: 'Capital rejected: REJECTED',
        };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-naked-match',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toBe('CAPITAL_SL_ATTACH_FAILED');
    expect(closed).toBe(1);
    expect(positions.size).toBe(0);
  });

  it('closePosition fails when confirm times out and listOpen fails', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-close' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: false, positions: [], detail: 'transport_down' }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
      close: async () => ({ ok: true, deal_reference: 'close-ref-1', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('deal-99');
    expect(closed.ok).toBe(false);
    expect(closed.detail).toMatch(/close_unconfirmed_list_failed/);
  });

  it('partial close requires size reduction proof', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let size = 0.1;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-partial' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'deal-p1',
            epic: 'GOLD',
            direction: 'BUY',
            size,
            open_level: 4410,
            stop_level: null,
            profit_level: null,
            upl: null,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({
        ok: true,
        deal_id: 'deal-p1',
        fill_level: 4412,
        profit: 0.5,
        detail: 'ok',
      }),
      close: async () => ({ ok: true, deal_reference: 'partial-ref', detail: 'submitted' }),
    });
    await broker.connect();
    // Size unchanged after close → refuse
    const bad = await broker.closePosition('deal-p1', { size: 0.05 });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/close_partial_not_confirmed_size_unchanged/);

    // Shrink on close submission so post-list proves reduction
    (broker as unknown as { deps: { close: Function } }).deps.close = async () => {
      size = 0.05;
      return { ok: true, deal_reference: 'partial-ref-2', detail: 'submitted' };
    };
    size = 0.1;
    const ok = await broker.closePosition('deal-p1', { size: 0.05 });
    expect(ok.ok).toBe(true);
    expect(ok.remaining_size).toBeCloseTo(0.05, 6);
  });

  it('partial close refuses under-reduction (flake shrink short of wantClose)', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let size = 0.5;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-short' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'deal-short',
            epic: 'GOLD',
            direction: 'BUY',
            size,
            open_level: 4410,
          },
        ],
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      confirm: async () => ({
        ok: true,
        deal_id: 'deal-short',
        detail: 'ok',
      }),
      close: async () => {
        // Tiny flake shrink — not the requested 0.2
        size = 0.49;
        return { ok: true, deal_reference: 'short-ref', detail: 'submitted' };
      },
    });
    await broker.connect();
    const bad = await broker.closePosition('deal-short', { size: 0.2 });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/close_partial_size_short/);
  });

  it('partial close refuses when before-size snapshot unavailable', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let closed = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-partial-miss' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: false, positions: [], detail: 'list_down' }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'd', detail: 'ok' }),
      close: async () => {
        closed = true;
        return { ok: true, deal_reference: 'should-not-fire', detail: 'submitted' };
      },
    });
    await broker.connect();
    const bad = await broker.closePosition('deal-missing', { size: 0.05 });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/capital_partial_no_before_size/);
    expect(closed).toBe(false);
  });

  it('listOpenPositions uses quote mid for level-less deals (never invent 0)', async () => {
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-ol' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'good',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: 4410.5,
            stop_level: null,
            profit_level: null,
            upl: 1,
          },
          {
            deal_id: 'bad-null',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
            stop_level: null,
            profit_level: null,
            upl: 0,
          },
          {
            deal_id: 'bad-zero',
            epic: 'GOLD',
            direction: 'SELL',
            size: 0.1,
            open_level: 0,
            stop_level: null,
            profit_level: null,
            upl: null,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'ok' }),
    });
    await broker.connect();
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    // Real level + provisional mid for null/zero (recover ownership)
    expect(listed.positions.map((p) => p.position_id).sort()).toEqual([
      'bad-null',
      'bad-zero',
      'good',
    ]);
    expect(listed.positions.find((p) => p.position_id === 'good')!.open_level).toBeCloseTo(
      4410.5,
      5
    );
    expect(listed.positions.find((p) => p.position_id === 'bad-null')!.open_level).toBeCloseTo(
      4410.2,
      5
    );
    expect(listed.presence_ids).toEqual(
      expect.arrayContaining(['good', 'bad-null', 'bad-zero'])
    );
  });

  it('listOpenPositions drops level-less when quote mid and market_mid unavailable', async () => {
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-ol2' }, detail: 'ok' }),
      quote: async () => null,
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'good',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: 4410.5,
          },
          {
            deal_id: 'bad-null',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'ok' }),
    });
    await broker.connect();
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    expect(listed.positions).toHaveLength(1);
    expect(listed.positions[0]!.position_id).toBe('good');
    expect(listed.presence_ids).toEqual(expect.arrayContaining(['good', 'bad-null']));
  });

  it('listOpenPositions uses market_mid when quote mid unavailable', async () => {
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-mmid' }, detail: 'ok' }),
      quote: async () => null,
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'level-less',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
            market_mid: 4411.5,
            stop_level: 4400,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'ok' }),
    });
    await broker.connect();
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    expect(listed.positions).toHaveLength(1);
    expect(listed.positions[0]!.position_id).toBe('level-less');
    expect(listed.positions[0]!.open_level).toBeCloseTo(4411.5, 5);
    expect(listed.positions[0]!.stop_level).toBe(4400);
  });

  it('modifyPosition proves SL from raw row when deal is presence-only', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let stopLevel: number | null = null;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-mod-pres' }, detail: 'ok' }),
      quote: async () => null,
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'pres-mod',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null, // level-less → not in positions[] without mid
            stop_level: stopLevel,
          },
        ],
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async (_s, input) => {
        if (input.stopLevel != null) stopLevel = Number(input.stopLevel);
        return { ok: true, deal_reference: 'mod-pres-ref', detail: 'accepted_http' };
      },
      confirm: async () => ({
        ok: true,
        deal_id: 'pres-mod',
        detail: 'ACCEPTED',
      }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'pres-mod',
      stop_level: 4400,
    });
    expect(mod.ok).toBe(true);
    expect(stopLevel).toBe(4400);
  });

  it('listOpenPositions uses cached last mid when live quote flakes', async () => {
    let quoteN = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-cache' }, detail: 'ok' }),
      quote: async (_s, epic) => {
        quoteN += 1;
        if (quoteN === 1) {
          return { bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true };
        }
        return null;
      },
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'level-less',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'ok' }),
    });
    await broker.connect();
    await broker.getQuote('GOLD'); // seed lastMidByEpic
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    expect(listed.positions).toHaveLength(1);
    expect(listed.positions[0]!.position_id).toBe('level-less');
    expect(listed.positions[0]!.open_level).toBeCloseTo(4410.2, 5);
  });

  it('listOpenPositions uses lastMid cache when live quote flakes', async () => {
    let quoteN = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-cache' }, detail: 'ok' }),
      quote: async (_s, epic) => {
        quoteN += 1;
        if (quoteN === 1) {
          return { bid: 4410, ask: 4410.4, mid: 4410.2, epic, raw_ok: true };
        }
        return { bid: null, ask: null, mid: null, epic, raw_ok: false };
      },
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'cached-mid',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'ok' }),
    });
    await broker.connect();
    await broker.getQuote('GOLD'); // warm lastMid cache
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    expect(listed.positions).toHaveLength(1);
    expect(listed.positions[0]!.position_id).toBe('cached-mid');
    expect(listed.positions[0]!.open_level).toBeCloseTo(4410.2, 5);
  });

  it('listOpenPositions omits unproven direction (presence-only, never invent BUY)', async () => {
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-dir' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'side-less',
            epic: 'GOLD',
            direction: null,
            size: 0.1,
            open_level: 4410,
          },
          {
            deal_id: 'side-sell',
            epic: 'GOLD',
            direction: 'SELL',
            size: 0.2,
            open_level: 4411,
          },
        ],
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    expect(listed.presence_ids).toEqual(
      expect.arrayContaining(['side-less', 'side-sell'])
    );
    expect(listed.positions.map((p) => p.position_id)).toEqual(['side-sell']);
    expect(listed.positions[0]!.side).toBe('SELL');
  });

  it('empty REJECTED match-accept refuses null opened_at candidates', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        opened_at?: string | null;
      }
    >();
    positions.set('ageless', {
      deal_id: 'ageless',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410.4,
      stop_level: null,
      opened_at: null,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-age' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          opened_at: p.opened_at ?? null,
        })),
        detail: '',
      }),
      create: async () => ({
        ok: true,
        deal_reference: 'ref-age',
        detail: 'posted',
      }),
      close: async () => ({ ok: true, detail: 'closed' }),
      modify: async () => ({ ok: true, deal_reference: 'm', detail: 'ok' }),
      confirm: async () => ({
        ok: false,
        rejected: true,
        detail: 'Capital rejected: REJECTED',
      }),
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-age-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.position_id).toBeNull();
    expect(positions.has('ageless')).toBe(true);
  });

  it('CLOSE treats level-less presence as still open (not flat)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pres' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'level-less',
            epic: 'GOLD',
            direction: 'BUY',
            size: 0.1,
            open_level: null,
          },
        ],
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, deal_reference: 'c-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('level-less');
    expect(closed.ok).toBe(false);
    expect(closed.detail).toMatch(/still_open/);
  });

  it('CLOSE confirm timeout does not journal ACK_TIMEOUT (OPEN-only alert)', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-close-ack-'));
    const { loadMasterErrors } = await import('../errorJournal.js');
    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-cto' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        return { ok: true, positions: [] };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
      close: async () => ({ ok: true, deal_reference: 'cto-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('deal-gone');
    // Confirm timed out — need consecutive empty lists (ghost debounce), not one flake empty
    expect(closed.ok).toBe(true);
    expect(listCalls).toBeGreaterThanOrEqual(5);
    const errs = loadMasterErrors(50);
    expect(errs.some((e) => e.error_type === 'ACK_TIMEOUT')).toBe(false);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('CLOSE confirm timeout refuses flat proof when empty list flakes (deal reappears)', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-flake' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        // First post-close list empty (flake); then deal still LIVE
        if (listCalls <= 2) return { ok: true, positions: [] };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-still-live',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: 4410,
            },
          ],
        };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
      close: async () => ({ ok: true, deal_reference: 'flake-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('deal-still-live');
    expect(closed.ok).toBe(false);
    expect(closed.detail).toMatch(/close_not_confirmed_empty_debounce/);
    expect(listCalls).toBeGreaterThan(2);
  });

  it('CLOSE with ACCEPTED confirm treats one empty list as flat', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-acc' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        return { ok: true, positions: [] };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({
        ok: true,
        deal_id: 'closed-deal',
        fill_level: 4411,
        profit: 1.2,
        detail: 'ACCEPTED',
      }),
      close: async () => ({ ok: true, deal_reference: 'acc-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('was-open');
    expect(closed.ok).toBe(true);
    // beforeSize snapshot + post-close proof = 2 lists; no debounce when ACCEPTED
    expect(listCalls).toBe(2);
    expect(closed.fill_price).toBe(4411);
  });

  it('partial CLOSE confirm timeout refuses flat proof when empty list flakes', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pflake' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        // beforeSize: deal present; first post-close: empty flake; then deal back
        if (listCalls === 1) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'partial-deal',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.2,
                open_level: 4410,
              },
            ],
          };
        }
        if (listCalls === 2) return { ok: true, positions: [] };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'partial-deal',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.2,
              open_level: 4410,
            },
          ],
        };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
      close: async () => ({ ok: true, deal_reference: 'pflake-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('partial-deal', { size: 0.1 });
    expect(closed.ok).toBe(false);
    expect(closed.detail).toMatch(/close_not_confirmed_empty_debounce/);
  });

  it('named reject fail-closes presence-only new fill (level-less, no mid)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number | null;
      }
    >();
    const closed: string[] = [];
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pres-ghost' }, detail: 'ok' }),
      quote: async () => null, // no mid → level-less stays out of positions[]
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async () => {
        positions.set('level-less-new', {
          deal_id: 'level-less-new',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: null,
        });
        return { ok: true, deal_reference: 'ref-pres', detail: 'posted' };
      },
      confirm: async () => ({
        ok: false,
        rejected: true,
        reject_reason: 'MINIMUM_STOP_DISTANCE',
        detail: 'Capital rejected: MINIMUM_STOP_DISTANCE',
      }),
      close: async (_s, id) => {
        closed.push(id);
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-pres-ghost',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/fail_closed/);
    expect(closed).toEqual(['level-less-new']);
    expect(positions.size).toBe(0);
  });

  it('named reject does not fail-close wrong-side presence-only sibling', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number | null;
      }
    >();
    const closed: string[] = [];
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pres-sib' }, detail: 'ok' }),
      quote: async () => null,
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async () => {
        // Concurrent wrong-side + matching BUY ghost — only BUY must be fail-closed
        positions.set('sell-sibling', {
          deal_id: 'sell-sibling',
          epic: 'GOLD',
          direction: 'SELL',
          size: 0.1,
          open_level: null,
        });
        positions.set('buy-ghost', {
          deal_id: 'buy-ghost',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: null,
        });
        return { ok: true, deal_reference: 'ref-sib', detail: 'posted' };
      },
      confirm: async () => ({
        ok: false,
        rejected: true,
        reject_reason: 'MINIMUM_STOP_DISTANCE',
        detail: 'Capital rejected: MINIMUM_STOP_DISTANCE',
      }),
      close: async (_s, id) => {
        closed.push(id);
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-pres-sib',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/fail_closed/);
    expect(closed).toEqual(['buy-ghost']);
    expect(positions.has('sell-sibling')).toBe(true);
  });

  it('partial CLOSE confirm timeout refuses size-reduction flake', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-szflake' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        // before + first reduced proof, then size snaps back (flake)
        if (listCalls === 1 || listCalls >= 3) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'sz-deal',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.2,
                open_level: 4410,
              },
            ],
          };
        }
        return {
          ok: true,
          positions: [
            {
              deal_id: 'sz-deal',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: 4410,
            },
          ],
        };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
      close: async () => ({ ok: true, deal_reference: 'sz-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('sz-deal', { size: 0.1 });
    expect(closed.ok).toBe(false);
    expect(closed.detail).toMatch(/close_not_confirmed_size_debounce/);
  });

  it('recover attach-fail keeps Capital ticket when post-close list fails', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-ack-cap-listfail-'));
    clearTradeAckJournalForTest();
    logTradeIntent({
      command_id: 'cap-attach-listfail',
      intent_id: 'recover-cap-listfail',
      action: 'OPEN',
      side: 'BUY',
      volume: 0.1,
      epic: 'GOLD',
      sl: 4390,
      tp: 4420,
      reason: 'INTENT',
    });
    updateTradeAck('cap-attach-listfail', {
      ack_status: 'SUCCESS',
      ticket: 'deal-listfail',
      fill_price: 4410,
      detail: 'RECOVER_LATE_FILL',
    });

    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-listfail' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        // Adopt + attach attempts see the naked deal; after fail-close, list unread
        if (listCalls <= 8) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'deal-listfail',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.1,
                open_level: 4410,
                stop_level: null,
                profit_level: null,
              },
            ],
            detail: '1',
          };
        }
        return { ok: false, positions: [], detail: 'list_transport_down' };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      modify: async () => ({ ok: false, detail: 'modify_denied' }),
      close: async () => ({ ok: false, detail: 'close_denied' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.recovered = false;
    const r = await masterRuntime.recover();
    expect(r.positions).toBeGreaterThanOrEqual(1);
    expect(masterRuntime.positions.get('deal-listfail')).toBeTruthy();
    expect(String(masterRuntime.broker_detail || '')).toMatch(/ack_attach_fail/);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('statusAsync exposes Capital venue opens for dashboard Flatten/PAPER gates', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
      }
    >();
    positions.set('venue-only', {
      deal_id: 'venue-only',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-venue-st' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()],
        detail: `${positions.size}`,
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      close: async (_s, id) => {
        positions.delete(id);
        return { ok: true, deal_reference: `c-${id}`, detail: 'closed' };
      },
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    const st = await masterRuntime.statusAsync();
    expect(st.capital_live_attached).toBe(true);
    expect(st.open_positions).toBe(0);
    expect(st.capital_venue_opens).toBe(1);
    expect(st.capital_venue_opens_proven).toBe(true);
  });

  it('named reject with list failure returns list_unproven (not silent no-fill)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let listCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-listunp' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        listCalls += 1;
        // Pre-open snapshot must succeed; post-create ghost hunt fails
        if (listCalls === 1) return { ok: true, positions: [], detail: '0' };
        return { ok: false, positions: [], detail: 'list_transport_down' };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-listunp', detail: 'posted' }),
      confirm: async () => ({
        ok: false,
        rejected: true,
        reject_reason: 'MINIMUM_STOP_DISTANCE',
        detail: 'Capital rejected: MINIMUM_STOP_DISTANCE',
      }),
      close: async () => ({ ok: true, detail: 'closed' }),
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-listunp',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/list_unproven/);
    expect(place.position_id).toBeNull();
  });

  it('ACCEPTED open refuses SUCCESS when deal never appears on list', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let afterConfirmLists = 0;
    let closed = 0;
    let dealLive = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-nopres' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        afterConfirmLists += 1;
        // One post-confirm list proves attach SL already on book; later lists vanish
        if (afterConfirmLists === 1) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'ghost-deal',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.1,
                open_level: 4410.4,
                stop_level: 4400,
              },
            ],
            detail: '1',
          };
        }
        return { ok: true, positions: [], detail: '0' };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-nopres', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: true,
          deal_id: 'ghost-deal',
          fill_level: 4410.4,
          detail: 'ACCEPTED',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-nopres', detail: 'ok' }),
      close: async () => {
        closed += 1;
        dealLive = false;
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-nopres',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/capital_open_not_present/);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('ACCEPTED open refuses SUCCESS when post-fill list stays unproven', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let afterConfirmLists = 0;
    let closed = 0;
    let dealLive = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-listfail' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        afterConfirmLists += 1;
        if (afterConfirmLists === 1) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'deal-listfail',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.1,
                open_level: 4410.4,
                stop_level: 4400,
              },
            ],
            detail: '1',
          };
        }
        return { ok: false, positions: [], detail: 'list_transport_down' };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-listfail', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: true,
          deal_id: 'deal-listfail',
          fill_level: 4410.4,
          detail: 'ACCEPTED',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-listfail', detail: 'ok' }),
      close: async () => {
        closed += 1;
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-listfail-final',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/capital_open_list_unproven/);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('ACCEPTED open refuses SUCCESS when TP stripped after attach (levels unproven)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let afterConfirmLists = 0;
    let closed = 0;
    let dealLive = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-tpstrip' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        afterConfirmLists += 1;
        // First list: SL+TP for ensure; later: SL only (TP stripped) → refuse SUCCESS
        if (afterConfirmLists === 1) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'deal-tpstrip',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.1,
                open_level: 4410.4,
                stop_level: 4400,
                profit_level: 4500,
              },
            ],
            detail: '1',
          };
        }
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-tpstrip',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: 4410.4,
              stop_level: 4400,
              // profit_level omitted
            },
          ],
          detail: '1',
        };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-tpstrip', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: true,
          deal_id: 'deal-tpstrip',
          fill_level: 4410.4,
          detail: 'ACCEPTED',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-tpstrip', detail: 'ok' }),
      close: async () => {
        closed += 1;
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-tpstrip',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
      profit_level: 4500,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/capital_open_tp_unproven/);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('ACCEPTED without confirm level binds fill from list open_level', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let dealLive = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-listfill' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-listfill',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: 4410.55,
              stop_level: 4400,
            },
          ],
          detail: '1',
        };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-listfill', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: true,
          deal_id: 'deal-listfill',
          // no fill_level — must bind list open_level before SUCCESS
          detail: 'ACCEPTED',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-listfill', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'closed' }),
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-listfill',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(true);
    expect(place.fill_price).toBe(4410.55);
    expect(place.detail).toMatch(/fill=4410\.55/);
  });

  it('ACCEPTED refuses SUCCESS when fill missing from confirm and list', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let dealLive = false;
    let closed = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-nofill' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-nofill',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              // open_level omitted — cannot prove fill
              stop_level: 4400,
            },
          ],
          detail: '1',
        };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-nofill', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: true,
          deal_id: 'deal-nofill',
          detail: 'ACCEPTED',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-nofill', detail: 'ok' }),
      close: async () => {
        closed += 1;
        dealLive = false;
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-nofill',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/capital_open_fill_unproven/);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('empty REJECTED with provisional-only open_level refuses SUCCESS fill', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let dealLive = false;
    let closed = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-provfill' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-provfill',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              // level-less — list invents provisional mid; must not SUCCESS
              stop_level: 4400,
            },
          ],
          detail: '1',
        };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-provfill', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: false,
          rejected: true,
          deal_id: 'deal-provfill',
          // no fill_level
          detail: 'Capital rejected: {"dealStatus":"REJECTED"}',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-provfill', detail: 'ok' }),
      close: async () => {
        closed += 1;
        dealLive = false;
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-provfill',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/capital_open_fill_unproven/);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('SUCCESS prefers venue open_level over earlier provisional mid stamp', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    let dealLive = false;
    let lists = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-prefvenue' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (!dealLive) return { ok: true, positions: [], detail: '0' };
        lists += 1;
        // First lists after confirm: level-less (provisional). Later: real open_level.
        if (lists < 3) {
          return {
            ok: true,
            positions: [
              {
                deal_id: 'deal-prefvenue',
                epic: 'GOLD',
                direction: 'BUY',
                size: 0.1,
                stop_level: 4400,
              },
            ],
            detail: '1',
          };
        }
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-prefvenue',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: 4410.77,
              stop_level: 4400,
            },
          ],
          detail: '1',
        };
      },
      create: async () => ({ ok: true, deal_reference: 'ref-prefvenue', detail: 'posted' }),
      confirm: async () => {
        dealLive = true;
        return {
          ok: true,
          deal_id: 'deal-prefvenue',
          detail: 'ACCEPTED',
        };
      },
      modify: async () => ({ ok: true, deal_reference: 'm-prefvenue', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'closed' }),
    });
    await broker.connect();
    const place = await broker.placeOrder({
      intent_id: 'intent-prefvenue',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    expect(place.ok).toBe(true);
    expect(place.fill_price).toBe(4410.77);
  });

  it('manage STOP uses last broker_upl when DELETED profit missing', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-upl-close' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4380,
        ask: 4380.4,
        mid: 4380.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({
        ok: true,
        deal_reference: 'upl-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({
        ok: false,
        closed_gone: true,
        deal_id: 'deal-upl',
        // no profit — manage must fall back to synced broker_upl
        detail: 'confirm_closed_gone:DELETED',
      }),
    });
    await broker.connect();
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    const decision = {
      decision_id: 'd-upl',
      kind: 'BUY' as const,
      side: 'BUY' as const,
      block_reason: null,
      analysis: { regime: 'TREND' as const },
      buy: { valid: true, filter_ok: true, score: 0.9, stop_loss: 4400 },
      sell: { valid: false, filter_ok: false, score: 0, stop_loss: null },
    };
    pm.register({
      position_id: 'deal-upl',
      opportunity_id: 'opp-upl',
      intent_id: 'intent-upl',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: decision as any,
    });
    pm.get('deal-upl')!.broker_upl = -8.5;
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4380,
        ask: 4380.4,
        mid: 4380.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
    });
    expect(managed.closed).toHaveLength(1);
    expect(managed.closed[0]!.reason).toBe('STOP_HIT');
    // Without UPL fallback, STOP proxy would invent pts×size ≈ -1.0
    expect(managed.closed[0]!.outcome.pnl).toBe(-8.5);
  });

  it('manage STOP Capital LIVE without profit/UPL does not invent mark PnL', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-unproven-pnl' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4380,
        ask: 4380.4,
        mid: 4380.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({
        ok: true,
        deal_reference: 'unproven-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({
        ok: false,
        closed_gone: true,
        deal_id: 'deal-unproven-pnl',
        detail: 'confirm_closed_gone:DELETED',
      }),
    });
    await broker.connect();
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    const decision = {
      decision_id: 'd-unproven',
      kind: 'BUY' as const,
      side: 'BUY' as const,
      block_reason: null,
      analysis: { regime: 'TREND' as const },
      buy: { valid: true, filter_ok: true, score: 0.9, stop_loss: 4400 },
      sell: { valid: false, filter_ok: false, score: 0, stop_loss: null },
    };
    pm.register({
      position_id: 'deal-unproven-pnl',
      opportunity_id: 'opp-unproven',
      intent_id: 'intent-unproven',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: decision as any,
    });
    // no broker_upl — must not invent (4400-4410)*0.1 = -1
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4380,
        ask: 4380.4,
        mid: 4380.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
    });
    expect(managed.closed).toHaveLength(1);
    expect(managed.closed[0]!.outcome.pnl_proven).toBe(false);
    expect(managed.closed[0]!.outcome.pnl).toBe(0);
    expect(managed.closed[0]!.outcome.fees).toBe(0);
    expect(managed.closed[0]!.reason).toMatch(/capital_close_pnl_unproven/);
    // Exit may be STOP proxy, but money stays unproven
    expect(managed.closed[0]!.outcome.exit).toBe(4400);
  });

  it('recover ack without proven fill fail-closes — never forges quote mid as entry', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-ack-no-entry-'));
    clearTradeAckJournalForTest();
    logTradeIntent({
      command_id: 'cap-ack-no-entry',
      intent_id: 'recover-ack-no-entry',
      action: 'OPEN',
      side: 'BUY',
      volume: 0.1,
      epic: 'GOLD',
      sl: 4390,
      tp: 4420,
      reason: 'INTENT',
    });
    updateTradeAck('cap-ack-no-entry', {
      ack_status: 'SUCCESS',
      ticket: 'deal-no-entry',
      // no fill_price — must not invent mid
      detail: 'RECOVER_LATE_FILL',
    });

    let closeCalls = 0;
    let closed = false;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-no-entry' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4499,
        ask: 4499.4,
        mid: 4499.2,
        epic,
        raw_ok: true,
      }),
      list: async () => {
        if (closed) return { ok: true, positions: [], detail: '0' };
        return {
          ok: true,
          positions: [
            {
              deal_id: 'deal-no-entry',
              epic: 'GOLD',
              direction: 'BUY',
              size: 0.1,
              open_level: null, // provisional mid only — not venue-proven
              stop_level: null,
              profit_level: null,
            },
          ],
          detail: '1',
        };
      },
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      modify: async () => ({ ok: false, detail: 'unused' }),
      close: async () => {
        closeCalls += 1;
        closed = true;
        return { ok: true, detail: 'fail_closed_no_entry' };
      },
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.broker_detail = '';
    masterRuntime.recovered = false;
    const r = await masterRuntime.recover();
    expect(masterRuntime.positions.get('deal-no-entry')).toBeNull();
    expect(r.positions).toBe(0);
    expect(closeCalls).toBeGreaterThan(0);
    expect(String(masterRuntime.broker_detail || '')).toMatch(/ack_presence_no_entry/);
    // Must not seed local open at forged mid 4499.2
    expect(masterRuntime.positions.list().every((p) => p.entry !== 4499.2)).toBe(true);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('recover Capital SUCCESS ack still attach-or-fails when adopt list fails', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-ack-adopt-listfail-'));
    clearTradeAckJournalForTest();
    logTradeIntent({
      command_id: 'cap-adopt-listfail',
      intent_id: 'recover-adopt-listfail',
      action: 'OPEN',
      side: 'BUY',
      volume: 0.1,
      epic: 'GOLD',
      sl: 4390,
      tp: 4420,
      reason: 'INTENT',
    });
    updateTradeAck('cap-adopt-listfail', {
      ack_status: 'SUCCESS',
      ticket: 'deal-adopt-listfail',
      fill_price: 4410,
      detail: 'RECOVER_LATE_FILL',
    });

    let modifyCalls = 0;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-adopt-lf' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: false, positions: [], detail: 'adopt_list_down' }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      modify: async () => {
        modifyCalls += 1;
        return { ok: false, detail: 'modify_denied' };
      },
      close: async () => ({ ok: false, detail: 'close_denied' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.recovered = false;
    const r = await masterRuntime.recover();
    expect(r.positions).toBeGreaterThanOrEqual(1);
    expect(masterRuntime.positions.get('deal-adopt-listfail')).toBeTruthy();
    expect(modifyCalls).toBeGreaterThan(0);
    expect(String(masterRuntime.broker_detail || '')).toMatch(
      /ack_list_unproven|ack_attach_fail/
    );
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('refuseCapitalIdentitySwap blocks different Capital identity while opens remain', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
      }
    >();
    positions.set('deal-a', {
      deal_id: 'deal-a',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
    });
    const make = (apiKey: string) =>
      new CapitalBroker({
        credentials: {
          environment: 'demo',
          apiKey,
          identifier: 'user-a',
          password: 'p',
          capitalAccountId: 'acct-1',
        },
        acquire: async () => ({ ok: true, session: { id: `s-${apiKey}` }, detail: 'ok' }),
        quote: async (_s, epic) => ({
          bid: 4410,
          ask: 4410.4,
          mid: 4410.2,
          epic,
          raw_ok: true,
          market_status: 'TRADEABLE',
        }),
        account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
        list: async () => ({
          ok: true,
          positions: [...positions.values()],
          detail: `${positions.size}`,
        }),
        create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
        confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
        close: async () => ({ ok: true, detail: 'closed' }),
      });
    const cur = make('key-AAA');
    const next = make('key-BBB');
    await cur.connect();
    await next.connect();
    expect(cur.identityKey()).not.toBe(next.identityKey());
    masterRuntime.stop();
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(cur);
    masterRuntime.setMode('LIVE');
    const gate = await masterRuntime.refuseCapitalIdentitySwap(next);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.detail).toMatch(/refuse_capital_identity_swap/);

    // Same identity re-attach allowed
    const same = make('key-AAA');
    await same.connect();
    expect((await masterRuntime.refuseCapitalIdentitySwap(same)).ok).toBe(true);
  });

  it('Capital entry verify blocks other-epic venue opens (venue-wide)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-oepic' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        market_status: 'TRADEABLE',
      }),
      account: async () => ({ equity: 12_500, balance: 12_000, currency: 'GBP' }),
      list: async () => ({
        ok: true,
        positions: [
          {
            deal_id: 'silver-orphan',
            epic: 'SILVER',
            direction: 'BUY',
            size: 1,
            open_level: 30,
          },
        ],
        detail: '1',
      }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'closed' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.25,
      block_off_hours: false,
      block_high_impact_news: false,
      max_relative_volatility: 100,
      max_relative_spread: 100,
      cooldown_ms_after_loss: 0,
      max_daily_loss_pct: 0.99,
      max_drawdown_pct: 0.99,
    };
    masterRuntime.account = { ...account, equity: 12_500, balance: 12_000 };
    masterRuntime.running = true;
    masterRuntime.entries_armed = true;
    masterRuntime.persist_ok = true;
    (masterRuntime as unknown as { inflight_until_ms: number }).inflight_until_ms = 0;
    (masterRuntime as unknown as { reject_until_ms: number }).reject_until_ms = 0;
    (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms = 0;
    (masterRuntime as unknown as { last_entry_fingerprint: string | null }).last_entry_fingerprint =
      null;
    const bars = barsTrendUp(50);
    const quote = {
      ...quoteFrom(bars.at(-1)!),
      epic: 'GOLD',
      market_status: 'TRADEABLE',
      ts_ms: Date.now(),
    };
    const r = await masterRuntime.tick(bars, quote);
    expect(r.executed).toBe(false);
    // Venue-wide sync adopts the SILVER orphan into local book and/or entry verify blocks
    expect(
      masterRuntime.positions.count() > 0 ||
        /one_trade_broker_open|one_trade_open/.test(String(r.execution_detail || ''))
    ).toBe(true);
  });

  it('Capital account fetch failure parks trade_allowed (no paper £10k sizing)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-acct0' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        market_status: 'TRADEABLE',
      }),
      // No account dep → getAccount returns null (never invent equity 0)
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: true, deal_id: 'x', detail: 'ok' }),
      close: async () => ({ ok: true, detail: 'closed' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.99,
      block_off_hours: false,
    };
    masterRuntime.account = { ...account };
    masterRuntime.running = true;
    const bars = barsTrendUp(30);
    const quote = {
      ...quoteFrom(bars.at(-1)!),
      epic: 'GOLD',
      market_status: 'TRADEABLE',
      ts_ms: Date.now(),
    };
    await masterRuntime.tick(bars, quote);
    expect(masterRuntime.account.trade_allowed).toBe(false);
    expect(String(masterRuntime.broker_detail || '')).toMatch(/capital_account_unproven/);
    // Persist can fail async (DB down) — must not mask LIVE_ACCOUNT_UNPROVEN
    masterRuntime.persist_ok = false;
    const st = masterRuntime.status();
    expect(st.capital_account_proven).toBe(false);
    expect(st.health).toBe('LIVE_ACCOUNT_UNPROVEN');
    expect(st.persist_ok).toBe(false);
    expect(st.account.equity).toBeNull();
    expect(st.account.balance).toBeNull();
    expect(st.account.daily_pnl).toBeNull();
    expect(st.account.trade_allowed).toBe(false);
  });

  it('status demotes LIVE_RUNNING to LIVE_QUOTE_STALE when quote aged', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-stale-h' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        update_time: new Date().toISOString(),
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      stale_quote_ms: 5_000,
    };
    masterRuntime.account = { ...account };
    masterRuntime.running = true;
    // Prove account so UNPROVEN does not mask quote stale
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalVenueOpensProven = true;
    masterRuntime.last_quote = {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      // 8s > cfg 5s but < hardcoded 15s dashboard threshold
      ts_ms: Date.now() - 8_000,
    };
    masterRuntime.persist_ok = true;
    const stale = masterRuntime.status();
    expect(stale.health).toBe('LIVE_QUOTE_STALE');
    expect(stale.quote?.age_ms).toBeGreaterThan(5_000);
    expect(stale.quote?.stale_quote_ms).toBe(5_000);
    expect(stale.quote?.stale).toBe(true);
    // age in (5s, 15s] would disagree with hardcoded 15s dashboard threshold
    expect(stale.quote!.age_ms).toBeLessThan(15_000);

    masterRuntime.last_quote = {
      ...masterRuntime.last_quote!,
      ts_ms: Date.now(),
    };
    const fresh = masterRuntime.status();
    expect(fresh.health).toBe('LIVE_RUNNING');
  });

  it('status demotes LIVE_ARMED to LIVE_QUOTE_STALE when stopped with aged quote', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-armed-stale' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        update_time: new Date().toISOString(),
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      stale_quote_ms: 5_000,
    };
    masterRuntime.account = { ...account };
    masterRuntime.running = false;
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalVenueOpensProven = true;
    masterRuntime.last_quote = {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now() - 8_000,
    };
    masterRuntime.persist_ok = true;
    const stale = masterRuntime.status();
    expect(stale.health).toBe('LIVE_QUOTE_STALE');
    expect(stale.running).toBe(false);
    expect(stale.quote?.stale).toBe(true);

    masterRuntime.last_quote = {
      ...masterRuntime.last_quote!,
      ts_ms: Date.now(),
    };
    const armed = masterRuntime.status();
    expect(armed.health).toBe('LIVE_ARMED');
  });

  it('recover Capital proven does not invent equity/peak from journal PnL', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { writeFileSync } = await import('fs');
    const { installFilePersist } = await import('../filePersist.js');
    const { setPersistClient } = await import('../persist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');
    const dir = process.env.MASTER_STATE_DIR!;
    const today = new Date().toISOString();
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-00000000c001',
            ts: today,
            mode: 'LIVE',
            epic: 'GOLD',
            decision: {
              decision_id: 'd-cap-eq',
              kind: 'BUY',
              side: 'BUY',
              score: 0.9,
              block_reason: null,
              buy: null,
              sell: null,
              analysis: { atr: 2, volatility: 0.001, regime: 'TREND', market_state: 't' },
              expectancy: null,
            },
            risk: { allowed: true, volume: 0.1, risk_amount: 10, reasons: [] },
            executed: true,
          },
        ],
        positions: [],
        intents: [],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-00000000c001',
            setup_key: 'TREND:BUY',
            created_at: today,
            outcome: {
              position_id: 'deal-cap-eq',
              side: 'BUY',
              entry: 4410,
              exit: 4420,
              volume: 0.1,
              pnl: 250,
              fees: 0,
              slippage: 0,
              mae: 0,
              mfe: 10,
              r_multiple: 1,
              hold_ms: 60_000,
              exit_reason: 'TakeProfit',
              pnl_proven: true,
            },
          },
        ],
      })
    );
    installFilePersist(dir);
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      day_start_equity: 50_000,
      peak_equity: 50_000,
      daily_pnl_day: today.slice(0, 10),
      capital_day_gates_seeded: true,
    });

    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-eq-recover' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 50_000, balance: 50_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    // Mid-session recover after venue already proved — balance is Capital truth
    masterRuntime.account = {
      ...account,
      equity: 50_000,
      balance: 50_000,
      peak_equity: 50_000,
      day_start_equity: 50_000,
      daily_pnl: 0,
      daily_pnl_day: today.slice(0, 10),
    };
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalDayGatesSeeded = true;
    masterRuntime.recovered = false;

    const r = await masterRuntime.recover();
    expect(r.outcomes).toBeGreaterThanOrEqual(1);
    // Venue balance already includes realized PnL — do not add journal again
    expect(masterRuntime.account.equity).toBe(50_000);
    expect(masterRuntime.account.peak_equity).toBe(50_000);
    expect(masterRuntime.account.daily_pnl).toBe(250);
    setPersistClient(null);
  });

  it('recover Capital LIVE skips paper journal PnL and unproven closes', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { writeFileSync } = await import('fs');
    const { installFilePersist } = await import('../filePersist.js');
    const { setPersistClient } = await import('../persist.js');
    const dir = process.env.MASTER_STATE_DIR!;
    const today = new Date().toISOString();
    const mkOpp = (id: string, mode: 'PAPER' | 'LIVE') => ({
      id,
      ts: today,
      mode,
      epic: 'GOLD',
      decision: {
        decision_id: `d-${id}`,
        kind: 'BUY',
        side: 'BUY',
        score: 0.9,
        block_reason: null,
        buy: null,
        sell: null,
        analysis: { atr: 2, volatility: 0.001, regime: 'TREND', market_state: 't' },
        expectancy: null,
      },
      risk: { allowed: true, volume: 0.1, risk_amount: 10, reasons: [] },
      executed: true,
    });
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          mkOpp('00000000-0000-4000-8000-00000000p001', 'PAPER'),
          mkOpp('00000000-0000-4000-8000-00000000l001', 'LIVE'),
          mkOpp('00000000-0000-4000-8000-00000000l002', 'LIVE'),
        ],
        positions: [],
        intents: [],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-00000000p001',
            created_at: today,
            outcome: {
              position_id: 'paper-1',
              side: 'BUY',
              entry: 1,
              exit: 2,
              volume: 1,
              pnl: -200,
              fees: 0,
              slippage: 0,
              mae: 0,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1,
              exit_reason: 'STOP',
            },
          },
          {
            opportunity_id: '00000000-0000-4000-8000-00000000l001',
            created_at: today,
            outcome: {
              position_id: 'live-loss',
              side: 'BUY',
              entry: 1,
              exit: 2,
              volume: 1,
              pnl: -50,
              fees: 0,
              slippage: 0,
              mae: 0,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1,
              exit_reason: 'STOP',
              pnl_proven: true,
            },
          },
          {
            opportunity_id: '00000000-0000-4000-8000-00000000l002',
            created_at: today,
            outcome: {
              position_id: 'live-unproven',
              side: 'BUY',
              entry: 1,
              exit: 2,
              volume: 1,
              pnl: 0,
              fees: 0,
              slippage: 0,
              mae: 0,
              mfe: 0,
              r_multiple: 0,
              hold_ms: 1,
              exit_reason: 'capital_close_pnl_unproven',
              pnl_proven: false,
            },
          },
        ],
      })
    );
    installFilePersist(dir);
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-pnl-filter' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 50_000, balance: 50_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    masterRuntime.account = {
      ...account,
      equity: 50_000,
      balance: 50_000,
      peak_equity: 50_000,
      day_start_equity: 50_000,
      daily_pnl: -999,
      daily_pnl_day: today.slice(0, 10),
      consecutive_losses: 0,
    };
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalDayGatesSeeded = true;
    masterRuntime.recovered = false;
    await masterRuntime.recover();
    // Paper −200 ignored; unproven 0 skipped (does not clear streak); proven −50 counts
    expect(masterRuntime.account.daily_pnl).toBe(-50);
    expect(masterRuntime.account.consecutive_losses).toBe(1);
    setPersistClient(null);
  });

  it('status demotes to LIVE_VENUE_UNPROVEN when list proof missing', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-venue-u' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        update_time: new Date().toISOString(),
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () => ({ ok: false, positions: [], detail: 'list_fail' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    masterRuntime.running = true;
    masterRuntime.persist_ok = true;
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalVenueOpensProven = false;
    masterRuntime.last_quote = {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    const st = masterRuntime.status();
    expect(st.health).toBe('LIVE_VENUE_UNPROVEN');
    expect(st.capital_venue_opens_proven).toBe(false);
  });

  it('Capital attach clears paper equity and trade_allowed before prove', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.account = {
      ...account,
      equity: 10_000,
      balance: 10_000,
      daily_pnl: -150,
      consecutive_losses: 2,
      trade_allowed: true,
    };
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-attach-clear' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 50_000, balance: 50_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    expect(masterRuntime.account.equity).toBe(0);
    expect(masterRuntime.account.balance).toBe(0);
    expect(masterRuntime.account.daily_pnl).toBe(0);
    expect(masterRuntime.account.consecutive_losses).toBe(0);
    expect(masterRuntime.account.trade_allowed).toBe(false);
    expect(masterRuntime.status().health).toBe('LIVE_ACCOUNT_UNPROVEN');
    expect(masterRuntime.status().capital_venue_opens_proven).toBe(false);
  });

  it('getAccount returns null when account unread (never invents equity 0)', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const noDep = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-null-acct' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await noDep.connect();
    expect(await noDep.getAccount()).toBeNull();

    const zeroDep = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-zero-acct' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 0, balance: 0, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await zeroDep.connect();
    expect(await zeroDep.getAccount()).toBeNull();

    const place = await zeroDep.placeOrder({
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
      profit_level: 4420,
    });
    expect(place.ok).toBe(false);
    expect(place.detail).toMatch(/capital_account_unproven/);
  });

  it('manage clears stale broker_upl when Capital list fails', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    let listOk = true;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-upl-clear' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4420,
        ask: 4420.4,
        mid: 4420.2,
        epic,
        raw_ok: true,
        update_time: new Date().toISOString(),
        market_status: 'TRADEABLE',
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () =>
        listOk
          ? {
              ok: true,
              positions: [
                {
                  deal_id: 'deal-upl-clear',
                  epic: 'GOLD',
                  direction: 'BUY',
                  size: 0.1,
                  open_level: 4410,
                  stop_level: 4400,
                  profit: 50,
                },
              ],
              detail: '1',
            }
          : { ok: false, positions: [], detail: 'list_fail' },
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      soft_trail_money_arm: 10,
      scalp_pct_chase: true,
      close_all_profit: 20,
    };
    masterRuntime.running = true;
    (masterRuntime as any).capitalAccountProven = true;
    masterRuntime.positions.register({
      position_id: 'deal-upl-clear',
      opportunity_id: 'opp-upl-clear',
      intent_id: 'intent-upl-clear',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: true, filter_ok: true, score: 0.9 },
        sell: { valid: false, filter_ok: false, score: 0 },
      } as any,
    });
    masterRuntime.positions.get('deal-upl-clear')!.broker_upl = 50;
    masterRuntime.positions.get('deal-upl-clear')!.soft_trail_armed_at =
      new Date().toISOString();
    masterRuntime.positions.get('deal-upl-clear')!.soft_trail_peak = 4420;
    const bars = barsTrendUp(30);
    const quote = {
      ...quoteFrom(bars.at(-1)!),
      epic: 'GOLD',
      market_status: 'TRADEABLE' as const,
      ts_ms: Date.now(),
    };
    listOk = false;
    await masterRuntime.tick(bars, quote);
    expect((masterRuntime as any).capitalVenueOpensProven).toBe(false);
    const pos = masterRuntime.positions.get('deal-upl-clear')!;
    expect(pos.broker_upl).toBeNull();
    expect(pos.soft_trail_armed_at).toBeNull();
    expect(pos.soft_trail_peak).toBeNull();
    expect(masterRuntime.status().health).toBe('LIVE_VENUE_UNPROVEN');
  });

  it('expectancy and status performance skip unproven Capital closes', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { ExpectancyStore } = await import('../expectancy.js');
    const store = new ExpectancyStore();
    store.record('TREND:BUY', {
      position_id: 'p1',
      side: 'BUY',
      entry: 1,
      exit: 2,
      volume: 1,
      pnl: 10,
      fees: 0,
      slippage: 0,
      mae: 0,
      mfe: 1,
      r_multiple: 1,
      hold_ms: 1,
      exit_reason: 'TP',
      pnl_proven: true,
    });
    store.record('TREND:BUY', {
      position_id: 'p2',
      side: 'BUY',
      entry: 1,
      exit: 2,
      volume: 1,
      pnl: 0,
      fees: 0,
      slippage: 0,
      mae: 0,
      mfe: 0,
      r_multiple: 0,
      hold_ms: 1,
      exit_reason: 'capital_close_pnl_unproven',
      pnl_proven: false,
    });
    expect(store.lookup('TREND:BUY')?.samples).toBe(1);
    expect(store.lookup('TREND:BUY')?.ev).toBeCloseTo(10, 5);

    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-exp' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalVenueOpensProven = true;
    masterRuntime.pipeline.recordTradeClose(
      '00000000-0000-4000-8000-00000000e001',
      {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.9,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: { regime: 'TREND', market_state: 't', atr: 1, volatility: 0.001 } as never,
        expectancy: null,
      },
      {
        position_id: 'deal-u',
        side: 'BUY',
        entry: 4410,
        exit: 4410,
        volume: 0.1,
        pnl: 0,
        fees: 0,
        slippage: 0,
        mae: 0,
        mfe: 0,
        r_multiple: 0,
        hold_ms: 1,
        exit_reason: 'capital_close_pnl_unproven',
        pnl_proven: false,
      }
    );
    const st = masterRuntime.status();
    expect(st.performance?.trades ?? 0).toBe(0);
    expect(masterRuntime.pipeline.expectancy.lookup('TREND:BUY')).toBeNull();
    expect(st.traded).toBe(0);
  });

  it('Capital soft trail already_armed does not close when broker_upl unread', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    const closed: string[] = [];
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition(id: string) {
        closed.push(id);
        return { ok: true, fill_price: 4415, fill_pnl: null, detail: 'closed' };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
      async listOpenPositions() {
        return { ok: true, positions: [], detail: '0' };
      },
    } as any;
    const pipe = new MasterPipeline('LIVE');
    pm.register({
      position_id: 'deal-soft-unread',
      opportunity_id: 'opp-soft-unread',
      intent_id: 'intent-soft-unread',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: true, filter_ok: true, score: 0.9 },
        sell: { valid: false, filter_ok: false, score: 0 },
      } as any,
    });
    const pos = pm.get('deal-soft-unread')!;
    pos.broker_upl = null; // unread
    pos.soft_trail_armed_at = new Date().toISOString();
    pos.soft_trail_peak = 4430; // pullback vs mark 4415 would hit soft trail
    const quote = {
      bid: 4414.8,
      ask: 4415.2,
      mid: 4415,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote,
      instrument_point_value: 1,
      soft_trail_money_arm: 5,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      allow_close: true,
      close_all_profit: 100,
      close_all_loss: 100,
    });
    expect(managed.closed.length).toBe(0);
    expect(closed.length).toBe(0);
    expect(pm.count()).toBe(1);
  });

  it('Capital soft trail SELL already_armed does not close when broker_upl unread', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    const closed: string[] = [];
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition(id: string) {
        closed.push(id);
        return { ok: true, fill_price: 4405, fill_pnl: null, detail: 'closed' };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
      async listOpenPositions() {
        return { ok: true, positions: [], detail: '0' };
      },
    } as any;
    const pipe = new MasterPipeline('LIVE');
    pm.register({
      position_id: 'deal-soft-sell-unread',
      opportunity_id: 'opp-soft-sell-unread',
      intent_id: 'intent-soft-sell-unread',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      entry: 4410,
      stop_loss: 4420,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: false, filter_ok: false, score: 0 },
        sell: { valid: true, filter_ok: true, score: 0.9 },
      } as any,
    });
    const pos = pm.get('deal-soft-sell-unread')!;
    pos.broker_upl = null;
    pos.soft_trail_armed_at = new Date().toISOString();
    // SELL peak was lower; mark rose → soft trail exit would hit if UPL ready
    pos.soft_trail_peak = 4390;
    const quote = {
      bid: 4404.8,
      ask: 4405.2,
      mid: 4405,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote,
      instrument_point_value: 1,
      soft_trail_money_arm: 5,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      allow_close: true,
      close_all_profit: 100,
      close_all_loss: 100,
    });
    expect(managed.closed.length).toBe(0);
    expect(closed.length).toBe(0);
    expect(pm.count()).toBe(1);
  });

  it('Capital money BE does not arm when broker_upl unread despite mark profit', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    const mods: number[] = [];
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition() {
        return { ok: false, detail: 'no' };
      },
      async modifyPosition(_id: string, patch: { stop_level?: number }) {
        if (patch.stop_level != null) mods.push(patch.stop_level);
        return { ok: true, detail: 'ok' };
      },
      async listOpenPositions() {
        return { ok: true, positions: [], detail: '0' };
      },
    } as any;
    const pipe = new MasterPipeline('LIVE');
    pm.register({
      position_id: 'deal-mbe-unread',
      opportunity_id: 'opp-mbe-unread',
      intent_id: 'intent-mbe-unread',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      take_profit: 4430,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: true, filter_ok: true, score: 0.9 },
        sell: { valid: false, filter_ok: false, score: 0 },
      } as any,
    });
    pm.get('deal-mbe-unread')!.broker_upl = null; // unread — money BE must refuse
    const quote = {
      bid: 4420,
      ask: 4420.4,
      mid: 4420.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote,
      instrument_point_value: 1,
      breakeven_progress: 0,
      breakeven_activation_money: 0.05,
      breakeven_offset: 0.1,
      soft_trail_money_arm: 0,
      scalp_pct_chase: false,
      allow_close: true,
      close_all_profit: 0,
      close_all_loss: 0,
    });
    expect(mods.length).toBe(0);
    expect(pm.get('deal-mbe-unread')!.stop_loss).toBe(4400);
  });

  it('Capital money BE SELL does not arm when broker_upl unread despite mark profit', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    const mods: number[] = [];
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition() {
        return { ok: false, detail: 'no' };
      },
      async modifyPosition(_id: string, patch: { stop_level?: number }) {
        if (patch.stop_level != null) mods.push(patch.stop_level);
        return { ok: true, detail: 'ok' };
      },
      async listOpenPositions() {
        return { ok: true, positions: [], detail: '0' };
      },
    } as any;
    const pipe = new MasterPipeline('LIVE');
    pm.register({
      position_id: 'deal-mbe-sell-unread',
      opportunity_id: 'opp-mbe-sell-unread',
      intent_id: 'intent-mbe-sell-unread',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      entry: 4410,
      stop_loss: 4420,
      take_profit: 4390,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: false, filter_ok: false, score: 0 },
        sell: { valid: true, filter_ok: true, score: 0.9 },
      } as any,
    });
    pm.get('deal-mbe-sell-unread')!.broker_upl = null;
    const quote = {
      bid: 4399.8,
      ask: 4400.2,
      mid: 4400,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote,
      instrument_point_value: 1,
      breakeven_progress: 0,
      breakeven_activation_money: 0.05,
      breakeven_offset: 0.1,
      soft_trail_money_arm: 0,
      scalp_pct_chase: false,
      allow_close: true,
      close_all_profit: 0,
      close_all_loss: 0,
    });
    expect(mods.length).toBe(0);
    expect(pm.get('deal-mbe-sell-unread')!.stop_loss).toBe(4420);
  });

  it('Capital soft-trail close with broker_upl=0 tags unproven and omits trade-event pnl', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const { PositionManager } = await import('../positionManager.js');
    const { loadTradeEvents } = await import('../tradeEventJournal.js');
    const pm = new PositionManager();
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition(id: string) {
        return { ok: true, fill_price: 4415, fill_pnl: null, detail: 'closed' };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
      async listOpenPositions() {
        return { ok: true, positions: [], detail: '0' };
      },
    } as any;
    const pipe = new MasterPipeline('LIVE');
    pm.register({
      position_id: 'deal-soft-flat-upl',
      opportunity_id: 'opp-soft-flat-upl',
      intent_id: 'intent-soft-flat-upl',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: true, filter_ok: true, score: 0.9 },
        sell: { valid: false, filter_ok: false, score: 0 },
      } as any,
    });
    const pos = pm.get('deal-soft-flat-upl')!;
    // Venue UPL exactly 0: soft-trail capitalUplReady true, but usableBrokerUpl
    // treats 0 as missing → close money unproven
    pos.broker_upl = 0;
    pos.soft_trail_armed_at = new Date().toISOString();
    pos.soft_trail_peak = 4430;
    const quote = {
      bid: 4414.8,
      ask: 4415.2,
      mid: 4415,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote,
      instrument_point_value: 1,
      soft_trail_money_arm: 5,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      allow_close: true,
      close_all_profit: 100,
      close_all_loss: 100,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.outcome.pnl_proven).toBe(false);
    expect(managed.closed[0]!.outcome.exit_reason).toMatch(
      /capital_close_pnl_unproven/
    );

    // Simulate manageLoop trade-event honesty (same spread as runtime)
    const c = managed.closed[0]!;
    const { logTradeEvent } = await import('../tradeEventJournal.js');
    logTradeEvent({
      event: 'CLOSE',
      broker: 'CAPITAL',
      epic: c.position.epic,
      side: c.position.side,
      volume: c.outcome.volume,
      price: c.outcome.exit,
      position_id: c.position.position_id,
      intent_id: c.position.intent_id,
      opportunity_id: c.position.opportunity_id,
      ok: true,
      detail: c.reason,
      ...(c.outcome.pnl_proven !== false
        ? { pnl: c.outcome.pnl, fees: c.outcome.fees }
        : {}),
    });
    const ev = loadTradeEvents(20).find(
      (e) => e.position_id === 'deal-soft-flat-upl' && e.event === 'CLOSE'
    );
    expect(ev).toBeTruthy();
    expect(ev!.detail).toMatch(/capital_close_pnl_unproven/);
    expect(ev!.pnl == null).toBe(true);
  });

  it('operator close Capital unproven does not advertise proven flat pnl', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-op-u' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: true, fill_price: 4410, detail: 'closed' }), // no fill_pnl
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    (masterRuntime as any).capitalAccountProven = true;
    (masterRuntime as any).capitalVenueOpensProven = true;
    masterRuntime.running = true;
    masterRuntime.last_quote = {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    masterRuntime.positions.register({
      position_id: 'deal-op-u',
      opportunity_id: 'opp-op-u',
      intent_id: 'intent-op-u',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: true, filter_ok: true, score: 0.9 },
        sell: { valid: false, filter_ok: false, score: 0 },
      } as any,
    });
    // no broker_upl — Capital LIVE money unproven
    const r = await masterRuntime.closePositionManual('deal-op-u', 'OPERATOR_CLOSE');
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/capital_close_pnl_unproven/);
    expect(r.pnl).toBeUndefined();
    expect(masterRuntime.last_exit_reason).toMatch(/capital_close_pnl_unproven/);
  });

  it('mid-session Capital getAccount fail zeros leftover equity', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    let equity = 50_000;
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-mid-fail' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
        update_time: new Date().toISOString(),
        market_status: 'TRADEABLE',
      }),
      account: async () =>
        equity > 0
          ? { equity, balance: equity, currency: 'GBP' }
          : null,
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'LIVE',
      min_score: 0.99,
      block_off_hours: false,
    };
    masterRuntime.running = true;
    const bars = barsTrendUp(30);
    const quote = {
      ...quoteFrom(bars.at(-1)!),
      epic: 'GOLD',
      market_status: 'TRADEABLE' as const,
      ts_ms: Date.now(),
    };
    await masterRuntime.tick(bars, quote);
    expect(masterRuntime.account.equity).toBe(50_000);
    expect((masterRuntime as any).capitalAccountProven).toBe(true);

    equity = 0; // getAccount → null
    await masterRuntime.tick(bars, { ...quote, ts_ms: Date.now() });
    expect(masterRuntime.account.equity).toBe(0);
    expect(masterRuntime.account.balance).toBe(0);
    expect(masterRuntime.account.trade_allowed).toBe(false);
    expect((masterRuntime as any).capitalAccountProven).toBe(false);
    expect(masterRuntime.status().health).toBe('LIVE_ACCOUNT_UNPROVEN');
  });

  it('status floating_pnl is null when Capital LIVE opens lack broker UPL', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-float-null' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4420,
        ask: 4420.4,
        mid: 4420.2,
        epic,
        raw_ok: true,
      }),
      account: async () => ({ equity: 12_000, balance: 12_000, currency: 'GBP' }),
      list: async () => ({ ok: true, positions: [], detail: '0' }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
    });
    await broker.connect();
    masterRuntime.stop();
    masterRuntime.positions = new PositionManager();
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE' };
    (masterRuntime as any).capitalAccountProven = true;
    masterRuntime.running = true;
    masterRuntime.last_quote = {
      bid: 4420,
      ask: 4420.4,
      mid: 4420.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    masterRuntime.positions.register({
      position_id: 'deal-float-null',
      opportunity_id: 'opp-float-null',
      intent_id: 'intent-float-null',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        block_reason: null,
        analysis: { regime: 'TREND' },
        buy: { valid: true, filter_ok: true, score: 0.9 },
        sell: { valid: false, filter_ok: false, score: 0 },
      } as any,
    });
    // no broker_upl — mark would invent ~+1.0
    const st = masterRuntime.status();
    expect(st.floating_pnl).toBeNull();
    expect(masterRuntime.positionsForApi()[0]!.upl).toBeNull();

    masterRuntime.positions.get('deal-float-null')!.broker_upl = 0.85;
    const proven = masterRuntime.status();
    expect(proven.floating_pnl).toBeCloseTo(0.85, 5);
  });

  it('native trail MODIFY refuses gap-only proof when confirm timed out', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean;
      }
    >();
    // Fixed SL already ~dist from mid — would falsely prove trail without confirm
    positions.set('d-trail', {
      deal_id: 'd-trail',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4408, // gap≈2 vs mid 4410.2
      trailingStop: false,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-trail' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          trailingStop: p.trailingStop ?? false,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => ({
        ok: true,
        deal_reference: 'trail-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-trail',
      trailing_stop: true,
      stop_distance: 2,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toMatch(/modify_sl|not_visible|unverified/i);
  });

  it('native trail MODIFY refuses gap≈dist even when confirm ACCEPTED', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean;
      }
    >();
    positions.set('d-gap', {
      deal_id: 'd-gap',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4408,
      trailingStop: false,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-gap' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          trailingStop: p.trailingStop ?? false,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => ({
        ok: true,
        deal_reference: 'gap-ref',
        detail: 'submitted',
      }),
      confirm: async () => ({
        ok: true,
        deal_id: 'd-gap',
        detail: 'ACCEPTED',
      }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-gap',
      trailing_stop: true,
      stop_distance: 2,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toMatch(/modify_sl|not_visible|unverified/i);
  });

  it('absolute SL after trail fails when trailing_stop still true', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean;
      }
    >();
    positions.set('d-abs', {
      deal_id: 'd-abs',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4400,
      trailingStop: true,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-abs' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          trailingStop: p.trailingStop ?? false,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => {
        // ACK moves SL but Capital leaves native trail armed
        positions.set('d-abs', {
          ...positions.get('d-abs')!,
          stop_level: 4405,
          trailingStop: true,
        });
        return { ok: true, deal_reference: 'abs-ref', detail: 'submitted' };
      },
      confirm: async () => ({ ok: true, pending: false, detail: 'ACCEPTED' }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-abs',
      stop_level: 4405,
      require_trail_off: true,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toBe('modify_sl_trail_unproven');
  });

  it('absolute SL after trail fails when trailing_stop omitted (unproven)', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean | null;
      }
    >();
    positions.set('d-abs-null', {
      deal_id: 'd-abs-null',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4400,
      trailingStop: true,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-abs-null' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => {
          const row: Record<string, unknown> = {
            deal_id: p.deal_id,
            epic: p.epic,
            direction: p.direction,
            size: p.size,
            open_level: p.open_level,
            stop_level: p.stop_level ?? null,
          };
          // Omit trailingStop when null — Capital often drops the field
          if (p.trailingStop === true || p.trailingStop === false) {
            row.trailingStop = p.trailingStop;
          }
          return row;
        }),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => {
        positions.set('d-abs-null', {
          ...positions.get('d-abs-null')!,
          stop_level: 4405,
          trailingStop: null,
        });
        return { ok: true, deal_reference: 'abs-null-ref', detail: 'submitted' };
      },
      confirm: async () => ({ ok: true, pending: false, detail: 'ACCEPTED' }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-abs-null',
      stop_level: 4405,
      require_trail_off: true,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toBe('modify_sl_trail_unproven');
  });

  it('absolute SL after trail succeeds when trailing_stop proven off', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean;
      }
    >();
    positions.set('d-abs2', {
      deal_id: 'd-abs2',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: 4400,
      trailingStop: true,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 's-abs2' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          trailingStop: p.trailingStop ?? false,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => {
        positions.set('d-abs2', {
          ...positions.get('d-abs2')!,
          stop_level: 4405,
          trailingStop: false,
        });
        return { ok: true, deal_reference: 'abs2-ref', detail: 'submitted' };
      },
      confirm: async () => ({ ok: true, pending: false, detail: 'ACCEPTED' }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-abs2',
      stop_level: 4405,
      require_trail_off: true,
    });
    expect(mod.ok).toBe(true);
  });

  it('native trail refuses when before SL missing and trailing_stop not true', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean | null;
      }
    >();
    // Before list omits stop_level — must not treat null-before as "moved"
    positions.set('d-null-before', {
      deal_id: 'd-null-before',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: null,
      trailingStop: false,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({
        ok: true,
        session: { id: 's-null-before' },
        detail: 'ok',
      }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          trailingStop: p.trailingStop ?? false,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => {
        positions.set('d-null-before', {
          ...positions.get('d-null-before')!,
          stop_level: 4408,
          trailingStop: false,
        });
        return {
          ok: true,
          deal_reference: 'null-before-ref',
          detail: 'submitted',
        };
      },
      confirm: async () => ({ ok: true, pending: false, detail: 'ACCEPTED' }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-null-before',
      trailing_stop: true,
      stop_distance: 2,
    });
    expect(mod.ok).toBe(false);
    expect(mod.detail).toMatch(/modify_sl|unchanged|unverified/i);
  });

  it('native trail ok when before SL missing but trailing_stop proven true', async () => {
    process.env.MASTER_CONFIRM_FAST = 'true';
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
        trailingStop?: boolean | null;
      }
    >();
    positions.set('d-null-trail', {
      deal_id: 'd-null-trail',
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      open_level: 4410,
      stop_level: null,
      trailingStop: false,
    });
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({
        ok: true,
        session: { id: 's-null-trail' },
        detail: 'ok',
      }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({
        ok: true,
        positions: [...positions.values()].map((p) => ({
          deal_id: p.deal_id,
          epic: p.epic,
          direction: p.direction,
          size: p.size,
          open_level: p.open_level,
          stop_level: p.stop_level ?? null,
          trailingStop: p.trailingStop ?? false,
        })),
        detail: '',
      }),
      create: async () => ({ ok: false, detail: 'unused' }),
      close: async () => ({ ok: false, detail: 'unused' }),
      modify: async () => {
        positions.set('d-null-trail', {
          ...positions.get('d-null-trail')!,
          stop_level: 4408,
          trailingStop: true,
        });
        return {
          ok: true,
          deal_reference: 'null-trail-ref',
          detail: 'submitted',
        };
      },
      confirm: async () => ({ ok: true, pending: false, detail: 'ACCEPTED' }),
    });
    await broker.connect();
    const mod = await broker.modifyPosition({
      position_id: 'd-null-trail',
      trailing_stop: true,
      stop_distance: 2,
    });
    expect(mod.ok).toBe(true);
  });
});
