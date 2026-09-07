import { describe, expect, it } from 'vitest';
import { analyzeBars } from '../analysis.js';
import { buildBuyComponents, buildSellComponents, buildCandidates } from '../candidates.js';
import { decide, pickPreferred } from '../decision.js';
import { ExpectancyStore } from '../expectancy.js';
import { MasterJournal } from '../journal.js';
import { computePerformance, monteCarlo } from '../performance.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
  specForEpic,
} from '../pipeline.js';
import { evaluateRisk, sizeFromEquity } from '../risk.js';
import { replayMaster, walkForward } from '../replay.js';
import type {
  AccountSnapshot,
  Bar,
  Quote,
  TradeCandidate,
  TradeOutcome,
} from '../types.js';

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
  it('classifies uptrend and builds dual candidates independently', async () => {
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

  it('does not call heuristic score a probability', async () => {
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
  it('equal valid scores → WAIT (Reader equal_scores)', () => {
    const mk = (side: 'BUY' | 'SELL', score: number): TradeCandidate => ({
      side,
      valid: true,
      score,
      components: {
        momentum: score,
        trend: score,
        structure: score,
        pressure: score,
        behavior: score,
        impact: score,
        context: score,
      },
      entry: 4400,
      stop_loss: side === 'BUY' ? 4395 : 4405,
      take_profit: side === 'BUY' ? 4410 : 4390,
      filter_ok: true,
      filter_reason: null,
    });
    expect(pickPreferred(mk('BUY', 0.7), mk('SELL', 0.7))).toBeNull();
    expect(pickPreferred(mk('BUY', 0.71), mk('SELL', 0.7))?.side).toBe('BUY');
    expect(pickPreferred(mk('BUY', 0.7), mk('SELL', 0.72))?.side).toBe('SELL');
  });

  it('near-tie min_score_delta → WAIT (Reader score_delta_too_small)', () => {
    const mk = (side: 'BUY' | 'SELL', score: number): TradeCandidate => ({
      side,
      valid: true,
      score,
      components: {
        momentum: score,
        trend: score,
        structure: score,
        pressure: score,
        behavior: score,
        impact: score,
        context: score,
      },
      entry: 4400,
      stop_loss: side === 'BUY' ? 4395 : 4405,
      take_profit: side === 'BUY' ? 4410 : 4390,
      filter_ok: true,
      filter_reason: null,
    });
    expect(pickPreferred(mk('BUY', 0.71), mk('SELL', 0.7), 0.05)).toBeNull();
    expect(pickPreferred(mk('BUY', 0.76), mk('SELL', 0.7), 0.05)?.side).toBe('BUY');
  });

  it('Check- profit_lock and equity_floor block new entries', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const locked = evaluateRisk(
      decision,
      { ...account, daily_pnl: 350 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, profit_lock: 300 }
    );
    expect(locked.allowed).toBe(false);
    expect(locked.reasons).toContain('profit_lock');

    const floor = evaluateRisk(
      decision,
      { ...account, equity: 500 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, equity_floor: 1000 }
    );
    expect(floor.allowed).toBe(false);
    expect(floor.reasons).toContain('equity_floor');
  });

  it('Check- hard $ daily_loss_limit blocks new entries', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const blocked = evaluateRisk(
      decision,
      { ...account, daily_pnl: -80 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, daily_loss_limit: 50, max_daily_loss_pct: 0.99 }
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('daily_loss_limit');

    const ok = evaluateRisk(
      decision,
      { ...account, daily_pnl: -40 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, daily_loss_limit: 50, max_daily_loss_pct: 0.99 }
    );
    expect(ok.reasons).not.toContain('daily_loss_limit');
  });

  it('account_not_tradeable blocks when trade_allowed is false', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const blocked = evaluateRisk(
      decision,
      { ...account, trade_allowed: false },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      DEFAULT_MASTER_CONFIG
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('account_not_tradeable');
  });

  it('BUY/SELL symmetry — dump prefers SELL', async () => {
    const bars = barsTrendDown();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    expect(d.sell.score).toBeGreaterThan(d.buy.score);
  });

  it('risk engine blocks kill switch and sizes from equity', async () => {
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

  it('stale quote and max daily loss block', async () => {
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

  it('intent idempotency — claim once', async () => {
    const pipe = new MasterPipeline('PAPER');
    const id = pipe.newIntentId('dec-1');
    expect(pipe.claimIntent(id)).toBe(true);
    expect(pipe.claimIntent(id)).toBe(false);
  });
});

describe('VS MASTER expectancy + journal', () => {
  it('computes EV from samples only — never invents', async () => {
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

  it('surfaceForApi keeps closed trades visible amid WAIT noise', () => {
    const j = new MasterJournal();
    const stubDecision = {
      decision_id: 'd',
      kind: 'WAIT' as const,
      side: null,
      score: 0,
      block_reason: 'noise',
      buy: null as never,
      sell: null as never,
      analysis: {} as never,
      expectancy: null,
    };
    const stubRisk = { allowed: false, volume: 0, risk_amount: 0, reasons: ['wait'] };
    for (let i = 0; i < 220; i++) {
      j.recordOpportunity({
        mode: 'PAPER',
        epic: 'GOLD',
        decision: stubDecision,
        risk: stubRisk,
        executed: false,
      });
    }
    const traded = j.recordOpportunity({
      mode: 'PAPER',
      epic: 'GOLD',
      decision: { ...stubDecision, kind: 'BUY', side: 'BUY', score: 0.7, block_reason: null },
      risk: { allowed: true, volume: 1, risk_amount: 10, reasons: [] },
      executed: true,
      id: 'trade-time-stop',
    });
    j.attachOutcome(traded.id, {
      position_id: 'p1',
      side: 'BUY',
      entry: 2000,
      exit: 2001,
      volume: 1,
      pnl: 1,
      fees: 0,
      slippage: 0,
      mae: 0,
      mfe: 1,
      r_multiple: 0.5,
      hold_ms: 2_700_000,
      exit_reason: 'TIME_STOP',
    });
    // Bury the closed trade under WAIT noise (naive last-200 would miss it)
    const idx = j.opportunities.findIndex((o) => o.id === 'trade-time-stop');
    const [row] = j.opportunities.splice(idx, 1);
    j.opportunities.unshift(row!);

    const naive = j.opportunities.slice(-200);
    expect(naive.some((o) => o.id === 'trade-time-stop')).toBe(false);

    const surface = j.surfaceForApi(50, 150);
    expect(surface.traded_count).toBe(1);
    expect(surface.opportunities.some((o) => o.id === 'trade-time-stop')).toBe(true);
    expect(surface.opportunities.find((o) => o.id === 'trade-time-stop')?.outcome?.exit_reason).toBe(
      'TIME_STOP'
    );
  });
});

describe('VS MASTER replay / walk-forward / monte carlo', () => {
  it('replay uses causal bars only and returns performance', async () => {
    const bars = [...barsTrendUp(80), ...barsTrendDown(80)];
    const result = await replayMaster({
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

  it('walk-forward returns in-sample and out-of-sample windows', async () => {
    const bars = [...barsTrendUp(60), ...barsTrendDown(60), ...barsTrendUp(60)];
    const wf = await walkForward({ bars, train: 70, test: 40, step: 50 });
    expect(wf.windows.length).toBeGreaterThan(0);
    expect(wf.windows[0]!.in_sample).toBeDefined();
    expect(wf.windows[0]!.out_of_sample).toBeDefined();
  });

  it('monte carlo uses empirical pnls only', async () => {
    const mc = monteCarlo([10, -5, 8, -3, 12, -7, 4], 200);
    expect(mc.drawdown_p95).toBeGreaterThanOrEqual(0);
    expect(mc.equity_p50).toBeDefined();
  });

  it('performance aggregates MAE/MFE/streaks', async () => {
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
  it('runs MARKET→VALIDATION→DECISION→RISK in one cycle', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    expect(result.decision.decision_id).toBeTruthy();
    expect(result.market.ok).toBe(true);
    expect(result.decision.buy.components).toBeDefined();
    expect(result.decision.sell.components).toBeDefined();
    expect(result.opportunity.executed).toBe(false);
    expect(['BUY', 'SELL', 'WAIT', 'BLOCK']).toContain(result.decision.kind);
  });

  it('blocks on invalid market data', async () => {
    const pipe = new MasterPipeline('PAPER');
    const result = await pipe.runCycle({
      bars: [{ open: 1, high: 1, low: 1, close: 1 }],
      quote: { bid: 1, ask: 1.01, mid: 1.005, spread: 0.01, ts_ms: Date.now() },
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    expect(result.market.ok).toBe(false);
    expect(result.decision.kind).toBe('BLOCK');
    expect(result.decision.block_reason).toMatch(/market_validation/);
  });
});

describe('VS MASTER AI layer', () => {
  it('required mode blocks without API key', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, ai_mode: 'required' },
    });
    expect(result.ai.ai_mode).toBe('required');
    expect(result.decision.kind).toBe('BLOCK');
    expect(result.decision.block_reason).toMatch(/ai_required_missing/);
  });

  it('advisory local advisor can with-trend allow', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, ai_mode: 'advisory', min_score: 0.3 },
    });
    expect(result.ai.ai_available).toBe(false);
    expect(result.ai.ai_fallback_used).toBe(true);
    expect(['BUY', 'SELL', 'WAIT', 'BLOCK']).toContain(result.decision.kind);
  });

  it('specForEpic resolves gold aliases and FX', () => {
    expect(specForEpic('XAUUSD').value_per_point_per_lot).toBe(GOLD_SPEC.value_per_point_per_lot);
    expect(specForEpic('EURUSD').min_volume).toBe(0.01);
    expect(specForEpic('BTCUSD').display_name).toMatch(/Bitcoin/i);
    expect(specForEpic('US100').volume_step).toBe(0.1);
    expect(specForEpic('US30').point).toBe(1);
    expect(specForEpic('GER40').display_name).toBe('GER40');
  });
});
