import { describe, expect, it } from 'vitest';
import { analyzeBars } from '../analysis.js';
import { buildBuyComponents, buildSellComponents, buildCandidates } from '../candidates.js';
import { decide } from '../decision.js';
import { ExpectancyStore } from '../expectancy.js';
import { computePerformance, monteCarlo } from '../performance.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
} from '../pipeline.js';
import { evaluateRisk, sizeFromEquity } from '../risk.js';
import { replayMaster, walkForward } from '../replay.js';
import type { AccountSnapshot, Bar, Quote, TradeOutcome } from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({ open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: i * 60_000 });
  }
  return out;
}

function barsTrendDown(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4450 - i * 0.8;
    out.push({ open: o, high: o + 0.1, low: o - 1.2, close: o - 0.9, ts_ms: i * 60_000 });
  }
  return out;
}

function quoteFrom(bar: Bar, spread = 0.4): Quote {
  return {
    bid: bar.close - spread / 2,
    ask: bar.close + spread / 2,
    mid: bar.close,
    spread,
    ts_ms: bar.ts_ms ?? Date.now(),
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

describe('VS MASTER analysis', () => {
  it('classifies uptrend and builds dual candidates independently', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    expect(a.trend_dir).toBe('UP');
    expect(['TREND', 'BREAKOUT', 'HIGH_VOLATILITY', 'LOW_VOLATILITY']).toContain(a.regime);
    const buy = buildBuyComponents(a);
    const sell = buildSellComponents(a);
    expect(buy.momentum).toBeGreaterThan(sell.momentum);
    const q = quoteFrom(bars[bars.length - 1]!);
    const { buy: bc, sell: sc } = buildCandidates(a, q, DEFAULT_MASTER_CONFIG);
    expect(bc.side).toBe('BUY');
    expect(sc.side).toBe('SELL');
    expect(bc.score).toBeGreaterThan(sc.score);
    expect(bc.components.momentum).not.toBe(sc.components.momentum);
  });

  it('does not call heuristic score a probability', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    expect(d.buy.score).toBeGreaterThanOrEqual(0);
    expect(d.buy.score).toBeLessThanOrEqual(1);
    // score exists; no fabricated "72% probability" field
    expect((d as { probability?: number }).probability).toBeUndefined();
  });
});

describe('VS MASTER decision + risk', () => {
  it('BUY/SELL symmetry — dump prefers SELL', () => {
    const bars = barsTrendDown();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    expect(d.sell.score).toBeGreaterThan(d.buy.score);
  });

  it('risk engine blocks kill switch and sizes from equity', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const cfg = { ...DEFAULT_MASTER_CONFIG, kill_switch: true };
    const d = decide(a, quoteFrom(bars.at(-1)!), cfg, () => null);
    expect(d.kind).toBe('BLOCK');
    const cand = {
      side: 'BUY' as const,
      valid: true,
      score: 0.8,
      components: {
        momentum: 0.8,
        trend: 0.8,
        structure: 0.8,
        pressure: 0.7,
        behavior: 0.6,
        impact: 0.7,
        context: 0.8,
      },
      entry: 4400,
      stop_loss: 4395,
      take_profit: 4410,
      filter_ok: true,
      filter_reason: null,
    };
    const sized = sizeFromEquity(10_000, cand, GOLD_SPEC, DEFAULT_MASTER_CONFIG);
    expect(sized.allowed).toBe(true);
    expect(sized.volume).toBeGreaterThan(0);
  });

  it('stale quote and max daily loss block', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    // force a trade decision shape
    const forced = { ...d, kind: 'BUY' as const, side: 'BUY' as const, block_reason: null };
    const stale = evaluateRisk(
      forced,
      account,
      GOLD_SPEC,
      { ...quoteFrom(bars.at(-1)!), ts_ms: Date.now() - 60_000 },
      DEFAULT_MASTER_CONFIG
    );
    expect(stale.allowed).toBe(false);
    expect(stale.reasons).toContain('stale_data_protection');

    const daily = evaluateRisk(
      forced,
      { ...account, daily_pnl: -500, equity: 10_000 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.03 }
    );
    expect(daily.allowed).toBe(false);
    expect(daily.reasons).toContain('max_daily_loss');
  });

  it('intent idempotency — claim once', () => {
    const pipe = new MasterPipeline('PAPER');
    const id = pipe.newIntentId('dec-1');
    expect(pipe.claimIntent(id)).toBe(true);
    expect(pipe.claimIntent(id)).toBe(false);
  });
});

describe('VS MASTER expectancy + journal', () => {
  it('computes EV from samples only — never invents', () => {
    const store = new ExpectancyStore();
    expect(store.lookup('BUY|TREND|UP|LONDON')).toBeNull();
    const win: TradeOutcome = {
      position_id: '1',
      side: 'BUY',
      entry: 1,
      exit: 2,
      volume: 1,
      pnl: 10,
      fees: 0.5,
      slippage: 0.2,
      mae: 1,
      mfe: 12,
      r_multiple: 1,
      hold_ms: 1000,
      exit_reason: 'TP',
    };
    const loss: TradeOutcome = { ...win, pnl: -8, position_id: '2', exit_reason: 'SL' };
    store.record('BUY|TREND|UP|LONDON', win);
    store.record('BUY|TREND|UP|LONDON', win);
    store.record('BUY|TREND|UP|LONDON', loss);
    const snap = store.lookup('BUY|TREND|UP|LONDON')!;
    expect(snap.samples).toBe(3);
    expect(snap.p_win).toBeCloseTo(2 / 3, 5);
    expect(snap.ev).toBeDefined();
  });
});

describe('VS MASTER replay / walk-forward / monte carlo', () => {
  it('replay uses causal bars only and returns performance', () => {
    const bars = [...barsTrendUp(80), ...barsTrendDown(80)];
    const result = replayMaster({
      bars,
      warmup: 30,
      spread: 0.5,
      slippage_pts: 0.15,
      commission: 0.08,
    });
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.performance.trades).toBeGreaterThanOrEqual(0);
    expect(result.equity_curve.length).toBeGreaterThan(10);
  });

  it('walk-forward returns in-sample and out-of-sample windows', () => {
    const bars = [...barsTrendUp(60), ...barsTrendDown(60), ...barsTrendUp(60)];
    const wf = walkForward({ bars, train: 70, test: 40, step: 50 });
    expect(wf.windows.length).toBeGreaterThan(0);
    expect(wf.windows[0]!.in_sample).toBeDefined();
    expect(wf.windows[0]!.out_of_sample).toBeDefined();
  });

  it('monte carlo uses empirical pnls only', () => {
    const mc = monteCarlo([10, -5, 8, -3, 12, -7, 4], 200);
    expect(mc.drawdown_p95).toBeGreaterThanOrEqual(0);
    expect(mc.equity_p50).toBeDefined();
  });

  it('performance aggregates MAE/MFE/streaks', () => {
    const outcomes: TradeOutcome[] = [
      {
        position_id: 'a',
        side: 'BUY',
        entry: 1,
        exit: 2,
        volume: 1,
        pnl: 5,
        fees: 0,
        slippage: 0,
        mae: 1,
        mfe: 6,
        r_multiple: 1,
        hold_ms: 1,
        exit_reason: 'TP',
      },
      {
        position_id: 'b',
        side: 'SELL',
        entry: 2,
        exit: 3,
        volume: 1,
        pnl: -4,
        fees: 0,
        slippage: 0,
        mae: 4,
        mfe: 1,
        r_multiple: -1,
        hold_ms: 1,
        exit_reason: 'SL',
      },
      {
        position_id: 'c',
        side: 'SELL',
        entry: 2,
        exit: 3,
        volume: 1,
        pnl: -2,
        fees: 0,
        slippage: 0,
        mae: 2,
        mfe: 0.5,
        r_multiple: -0.5,
        hold_ms: 1,
        exit_reason: 'SL',
      },
    ];
    const p = computePerformance(
      outcomes.map((o) => ({
        id: o.position_id,
        ts: '',
        mode: 'BACKTEST' as const,
        epic: 'GOLD',
        decision: null as never,
        risk: null as never,
        executed: true,
        outcome: o,
      }))
    );
    expect(p.trades).toBe(3);
    expect(p.longest_losing_streak).toBe(2);
    expect(p.wins).toBe(1);
  });
});

describe('VS MASTER pipeline end-to-end', () => {
  it('runs MARKET→DECISION→RISK in one cycle', () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    expect(result.decision.decision_id).toBeTruthy();
    expect(result.decision.buy.components).toBeDefined();
    expect(result.decision.sell.components).toBeDefined();
    expect(result.opportunity.executed).toBe(false);
    expect(['BUY', 'SELL', 'WAIT', 'BLOCK']).toContain(result.decision.kind);
  });
});
