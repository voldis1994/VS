import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../broker.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { safetyStopLevel, syncPositionsWithBroker } from '../positionSync.js';
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

describe('VS MASTER recovery SL + trail', () => {
  it('copies broker stop_level when adopting orphans', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'orphan-with-sl-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4395,
      profit_level: 4410,
    });
    expect(placed.ok).toBe(true);

    const pm = new PositionManager();
    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD');
    expect(sync.adopted).toBe(1);
    expect(sync.safety_sl_attached).toBe(0);
    const pos = pm.get(placed.position_id!);
    expect(pos).toBeTruthy();
    expect(pos!.stop_loss).toBe(4395);
    expect(pos!.take_profit).toBe(4410);
  });

  it('attaches safety SL when orphan has no broker stop', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'orphan-naked-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
    });
    expect(placed.ok).toBe(true);
    // Clear stop on paper position to simulate naked orphan
    const opens = await broker.listOpenPositions('GOLD');
    const raw = opens.positions.find((p) => p.position_id === placed.position_id)!;
    expect(raw.stop_level).toBeNull();

    const pm = new PositionManager();
    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD');
    expect(sync.adopted).toBe(1);
    expect(sync.safety_sl_attached).toBe(1);
    const pos = pm.get(placed.position_id!);
    const expected = safetyStopLevel('BUY', raw.open_level);
    expect(pos!.stop_loss).toBeCloseTo(expected, 5);
    const after = await broker.listOpenPositions('GOLD');
    expect(after.positions[0]!.stop_level).toBeCloseTo(expected, 5);
  });

  it('trails stop via modifyPosition when MFE clears floor', async () => {
    const bars = barsTrendUp();
    const pipe = new MasterPipeline('PAPER');
    const cycle = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.4,
      mid: entry + 0.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'trail-test-cccccccccccccccc',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
    });
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: cycle.opportunity.id,
      intent_id: 'trail-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 2,
      decision: { ...cycle.decision, kind: 'BUY', side: 'BUY' },
    });

    const up: Quote = {
      bid: entry + 3,
      ask: entry + 3.4,
      mid: entry + 3.2,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    broker.setQuote({
      bid: up.bid,
      ask: up.ask,
      mid: up.mid,
      spread: up.spread,
      epic: 'GOLD',
      ts_ms: up.ts_ms,
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: up,
      instrument_point_value: 1,
    });
    expect(managed.closed.length).toBe(0);
    const held = pm.get(placed.position_id!);
    expect(held!.stop_loss!).toBeGreaterThan(entry - 2);
    expect(held!.stop_loss!).toBeLessThan(up.mid);
    const opens = await broker.listOpenPositions('GOLD');
    expect(opens.positions[0]!.stop_level!).toBeCloseTo(held!.stop_loss!, 5);
  });

  it('skips reconcile when broker list fails (does not wipe locals)', async () => {
    const pm = new PositionManager();
    pm.register({
      position_id: 'keep-me',
      opportunity_id: 'opp-keep',
      intent_id: 'intent-keep',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4395,
      decision: {
        decision_id: 'd1',
        kind: 'BUY',
        side: 'BUY',
        score: 0.5,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'UNKNOWN',
          market_state: 'test',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0,
          structure_bias: 'NEUTRAL',
          swing_high: 4405,
          swing_low: 4395,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.001,
          atr: 1,
          data_quality: 0.5,
          session: 'UNKNOWN',
        },
        expectancy: null,
      },
    });
    const broker = {
      name: 'MOCK_FAIL',
      paper: false,
      async connect() {
        return { ok: true, detail: 'ok' };
      },
      async getQuote() {
        return null;
      },
      async getAccount() {
        return null;
      },
      async listOpenPositions() {
        return { ok: false, positions: [], detail: 'transport_error' };
      },
      async placeOrder() {
        return {
          ok: false,
          order_id: null,
          position_id: null,
          fill_price: null,
          detail: 'n/a',
          paper: false,
        };
      },
      async closePosition() {
        return { ok: false, detail: 'n/a' };
      },
    };
    const sync = await syncPositionsWithBroker(pm, broker as any, 'GOLD');
    expect(sync.skipped).toBe(true);
    expect(sync.skip_reason).toMatch(/transport/);
    expect(pm.count()).toBe(1);
    expect(pm.get('keep-me')).toBeTruthy();
  });
});
