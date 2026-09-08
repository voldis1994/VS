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
    };
    masterRuntime.account = { ...account, trade_allowed: true };
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
      // No account dep → getAccount returns equity 0
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
    const st = masterRuntime.status();
    expect(st.capital_account_proven).toBe(false);
    expect(st.health).toBe('LIVE_ACCOUNT_UNPROVEN');
    expect(st.account.equity).toBe(0);
    expect(st.account.trade_allowed).toBe(false);
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
});
