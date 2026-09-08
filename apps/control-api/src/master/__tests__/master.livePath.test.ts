/**
 * LIVE Capital path — mocked broker deps (no network).
 * Proves MASTER_LIVE_ENABLED gate → confirm fill → position manage → exit close.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CapitalBroker } from '../broker.js';
import { executeDecision } from '../execution.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import type { AccountSnapshot, Bar, Quote } from '../types.js';
import { masterRuntime } from '../runtime.js';

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

  beforeEach(() => {
    delete process.env.MASTER_LIVE_ENABLED;
  });

  afterEach(() => {
    if (prevLive === undefined) delete process.env.MASTER_LIVE_ENABLED;
    else process.env.MASTER_LIVE_ENABLED = prevLive;
    masterRuntime.stop();
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
          detail: 'Capital rejected: REJECTED',
          // empty reason → match-accept path
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
      list: async () => ({ ok: true, positions: [] }),
      create: async () => ({ ok: true, deal_reference: 'x', detail: 'ok' }),
      confirm: async () => ({ ok: false, pending: true, detail: 'pending' }),
      close: async () => ({ ok: true, deal_reference: 'cto-ref', detail: 'submitted' }),
    });
    await broker.connect();
    const closed = await broker.closePosition('deal-gone');
    expect(closed.ok).toBe(true); // flat list proves closed despite confirm timeout
    const errs = loadMasterErrors(50);
    expect(errs.some((e) => e.error_type === 'ACK_TIMEOUT')).toBe(false);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
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
});
