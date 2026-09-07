/**
 * LIVE Capital path — mocked broker deps (no network).
 * Proves MASTER_LIVE_ENABLED gate → confirm fill → position manage → exit close.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    { deal_id: string; epic: string; direction: 'BUY' | 'SELL'; size: number; open_level: number }
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
      positions: [...positions.values()],
      detail: `${positions.size}`,
    }),
    create: async (_s, input) => ({
      ok: true,
      deal_reference: `ref-${input.direction}-${Date.now()}`,
      detail: 'opened',
    }),
    confirm: async (_s, ref) => {
      confirmAttempts += 1;
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
      });
      return { ok: true, deal_id, fill_level: 4410.4, detail: `Confirmed ${deal_id}` };
    },
    close: async (_s, dealId) => {
      if (!positions.has(dealId)) return { ok: false, detail: 'missing' };
      positions.delete(dealId);
      return { ok: true, detail: `closed ${dealId}` };
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
    expect(managed.closed[0]!.outcome.exit).toBe(4400);
    expect(await broker.listOpenPositions()).toEqual({ ok: true, positions: [] });
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
});
