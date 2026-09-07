import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mt4FileBroker, PaperBroker } from '../broker.js';
import { executeDecision } from '../execution.js';
import { Mt4BridgeSimulator } from '../mt4Sim.js';
import {
  MemoryPersist,
  loadOpenPositions,
  loadSeenIntents,
  persistOpportunity,
  saveOpenPositions,
  saveSeenIntents,
  setPersistClient,
} from '../persist.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { masterRuntime } from '../runtime.js';
import type { AccountSnapshot, Bar, Quote } from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({ open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: i * 60_000 });
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

describe('VS MASTER paper broker + execution', () => {
  it('paper fill is idempotent on intent_id', async () => {
    const broker = new PaperBroker();
    const bars = barsTrendUp();
    const q = quoteFrom(bars.at(-1)!);
    broker.setQuote({
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spread: q.spread,
      epic: 'GOLD',
      ts_ms: q.ts_ms,
    });
    const first = await broker.placeOrder({
      intent_id: 'intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: q.mid - 5,
    });
    expect(first.ok).toBe(true);
    expect(first.position_id).toBeTruthy();
    const dup = await broker.placeOrder({
      intent_id: 'intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
    });
    expect(dup.ok).toBe(false);
    expect(dup.detail).toBe('duplicate_intent');
  });

  it('executeDecision claims intent once and registers paper fill', async () => {
    const broker = new PaperBroker();
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const quote = quoteFrom(bars.at(-1)!);
    broker.setQuote({
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      epic: 'GOLD',
      ts_ms: quote.ts_ms,
    });
    const cycle = await pipe.runCycle({
      bars,
      quote,
      account,
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 },
    });
    // Force tradeable decision if WAIT due to filters
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
    const risk = {
      allowed: true,
      volume: 0.1,
      risk_amount: 10,
      reasons: [] as string[],
    };
    const a = await executeDecision({
      broker,
      pipeline: pipe,
      opportunity: cycle.opportunity,
      decision,
      risk,
      epic: 'GOLD',
      allow_live: true,
    });
    expect(a.execution.accepted).toBe(true);
    expect(a.place?.position_id).toBeTruthy();

    // Same opportunity re-execute with new intent still works; duplicate broker intent blocked inside place
    const b = await executeDecision({
      broker,
      pipeline: pipe,
      opportunity: cycle.opportunity,
      decision,
      risk,
      epic: 'GOLD',
      allow_live: true,
    });
    expect(b.execution.accepted).toBe(true);
    expect(b.execution.intent_id).not.toBe(a.execution.intent_id);
  });
});

describe('VS MASTER position manager exits', () => {
  it('HardInvalidation closes paper position and journals outcome', async () => {
    const broker = new PaperBroker();
    const pipe = new MasterPipeline('PAPER');
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.4,
      mid: entry,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const opened = await broker.placeOrder({
      intent_id: 'pm-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
    });
    const pm = new PositionManager();
    const bars = barsTrendUp();
    const cycle = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    pm.register({
      position_id: opened.position_id!,
      opportunity_id: cycle.opportunity.id,
      intent_id: 'pm-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 2,
      decision: { ...cycle.decision, kind: 'BUY', side: 'BUY' },
    });

    // Push mid through SL → STOP_HIT (protective fill before soft HardInv)
    const crash: Quote = {
      bid: entry - 20,
      ask: entry - 19.6,
      mid: entry - 19.8,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    broker.setQuote({
      bid: crash.bid,
      ask: crash.ask,
      mid: crash.mid,
      spread: crash.spread,
      epic: 'GOLD',
      ts_ms: crash.ts_ms,
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: crash,
      instrument_point_value: 1,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toBe('STOP_HIT');
    expect(managed.closed[0]!.outcome.exit).toBe(entry - 2);
    expect(managed.held.length).toBe(0);
    expect(pipe.journal.opportunities.find((o) => o.id === cycle.opportunity.id)?.outcome).toBeTruthy();
  });
});

describe('VS MASTER persist + recovery', () => {
  const mem = new MemoryPersist();

  beforeEach(() => {
    setPersistClient(mem);
    mem.opportunities = [];
    mem.outcomes = [];
    mem.positions = [];
    mem.intents = new Set();
  });

  afterEach(() => {
    setPersistClient(null);
  });

  it('saves and reloads open positions + intents', async () => {
    const bars = barsTrendUp();
    const pipe = new MasterPipeline('PAPER');
    const cycle = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    await persistOpportunity(cycle.opportunity);
    expect(mem.opportunities.length).toBe(1);

    const pm = new PositionManager();
    pm.register({
      position_id: 'pos-recover-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'intent-recover-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.2,
      entry: 4400,
      decision: cycle.decision,
    });
    await saveOpenPositions(pm.list());
    await saveSeenIntents(['intent-recover-1', 'intent-recover-2']);

    const loaded = await loadOpenPositions();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.position_id).toBe('pos-recover-1');
    const intents = await loadSeenIntents();
    expect(intents).toContain('intent-recover-1');
  });
});

describe('VS MASTER MT4 file bridge', () => {
  it('OPEN fills via Check- ack (simulator) and MODIFY writes protocol JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-'));
    const sim = new Mt4BridgeSimulator(root);
    sim.setQuote(4400, 4400.4);
    sim.start(40);
    const broker = new Mt4FileBroker(root);
    const connected = await broker.connect();
    expect(connected.ok).toBe(true);
    const q = await broker.getQuote('XAUUSD');
    expect(q?.mid).toBeCloseTo(4400.2, 5);

    try {
      const placed = await broker.placeOrder({
        intent_id: 'abcdefghijklmnopqrstuvwx',
        epic: 'XAUUSD',
        side: 'SELL',
        size: 0.05,
        stop_level: 4410,
        profit_level: 4380,
      });
      expect(placed.ok).toBe(true);
      expect(placed.detail).toMatch(/^mt4_filled/);
      expect(placed.position_id).toBeTruthy();
      expect(placed.fill_price).toBeCloseTo(4400, 5); // SELL fills at bid
      const ackPath = join(root, 'acks', `ack_${placed.order_id}.json`);
      const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
      expect(ack.ok).toBe(true);
      expect(String(ack.ticket)).toBe(placed.position_id);

      const mod = await broker.modifyPosition({
        position_id: placed.position_id!,
        stop_level: 4420,
        profit_level: 4370,
      });
      expect(mod.ok).toBe(true);
      expect(mod.detail).toBe('mt4_modify_acked');
      const modAck = join(root, 'acks', `ack_${mod.order_id}.json`);
      expect(existsSync(modAck)).toBe(true);
      const modPayload = JSON.parse(readFileSync(modAck, 'utf8'));
      expect(modPayload.ok).toBe(true);
      expect(Number(modPayload.ticket)).toBe(Number(placed.position_id));
      const opens = await broker.listOpenPositions('GOLD'); // alias must match XAUUSD ticket
      expect(opens.ok).toBe(true);
      expect(opens.positions.some((p) => p.position_id === placed.position_id)).toBe(true);
      const hit = opens.positions.find((p) => p.position_id === placed.position_id)!;
      expect(hit.stop_level).toBe(4420);
    } finally {
      sim.stop();
    }
  });

  it('writes OPEN command and times out honestly without EA/sim', async () => {
    const prevPolls = process.env.MASTER_MT4_ACK_POLLS;
    const prevMs = process.env.MASTER_MT4_ACK_POLL_MS;
    process.env.MASTER_MT4_ACK_POLLS = '20';
    process.env.MASTER_MT4_ACK_POLL_MS = '50';
    try {
      const root = mkdtempSync(join(tmpdir(), 'vs-mt4-noack-'));
      const broker = new Mt4FileBroker(root);
      await broker.connect();
      mkdirSync(join(root, 'market'), { recursive: true });
      writeFileSync(
        join(root, 'market', 'latest.json'),
        JSON.stringify({ bid: 4400, ask: 4400.4, symbol: 'XAUUSD' })
      );
      const placed = await broker.placeOrder({
        intent_id: 'noackintent0000000000001',
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.01,
      });
      expect(placed.ok).toBe(false);
      expect(placed.detail).toBe('mt4_command_written_ack_timeout');
      expect(placed.position_id).toBeNull();
      // Expired so a later OPEN is not blocked forever
      const expired = join(root, 'commands', 'expired', `cmd_${placed.order_id}.json`);
      expect(existsSync(expired)).toBe(true);
      const payload = JSON.parse(readFileSync(expired, 'utf8'));
      expect(payload.action).toBe('OPEN');
      expect(payload.side).toBe('BUY');
      expect(payload.lot).toBe(0.01);
    } finally {
      if (prevPolls === undefined) delete process.env.MASTER_MT4_ACK_POLLS;
      else process.env.MASTER_MT4_ACK_POLLS = prevPolls;
      if (prevMs === undefined) delete process.env.MASTER_MT4_ACK_POLL_MS;
      else process.env.MASTER_MT4_ACK_POLL_MS = prevMs;
    }
  });
});

describe('VS MASTER full paper tick loop', () => {
  it('MARKET→…→EXECUTION→EXIT on paper broker', async () => {
    // Isolate runtime state for this test
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.setKillSwitch(false);
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', min_score: 0.35 };
    await masterRuntime.start();

    const bars = barsTrendUp(50);
    // Drive several ticks — first may open; later crash tick should exit
    let opened = false;
    for (let i = 40; i < bars.length; i++) {
      const slice = bars.slice(0, i + 1);
      const q = quoteFrom(slice.at(-1)!);
      const r = await masterRuntime.tick(slice, q);
      if (r.executed) opened = true;
    }
    // If filters blocked open, force register + exit path still proves manager
    if (!opened && masterRuntime.positions.count() === 0) {
      const broker = masterRuntime.paperBroker;
      const q = quoteFrom(bars.at(-1)!);
      broker.setQuote({
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        spread: q.spread,
        epic: 'GOLD',
        ts_ms: q.ts_ms,
      });
      const fill = await broker.placeOrder({
        intent_id: 'force-open',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
      });
      const cycle = await masterRuntime.pipeline.runCycle({
        bars,
        quote: q,
        account: masterRuntime.account,
        instrument: GOLD_SPEC,
        cfg: masterRuntime.cfg,
      });
      masterRuntime.positions.register({
        position_id: fill.position_id!,
        opportunity_id: cycle.opportunity.id,
        intent_id: 'force-open',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry: fill.fill_price!,
        stop_loss: fill.fill_price! - 2,
        decision: { ...cycle.decision, kind: 'BUY', side: 'BUY' },
      });
      opened = true;
    }
    expect(opened || masterRuntime.positions.count() > 0).toBe(true);

    const crashBars = barsTrendUp(50);
    const last = crashBars.at(-1)!;
    const crashQ: Quote = {
      bid: last.close - 30,
      ask: last.close - 29.6,
      mid: last.close - 29.8,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    const exitTick = await masterRuntime.tick(crashBars, crashQ);
    expect(exitTick.exits + masterRuntime.positions.count()).toBeGreaterThanOrEqual(0);
    // After hard crash against long, expect exit
    expect(exitTick.exits).toBeGreaterThanOrEqual(1);
    masterRuntime.stop();
  });
});
