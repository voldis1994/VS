import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMicroAccountConfig,
  isMicroAccountMode,
  reseedMicroAccountGates,
} from '../microAccountRisk.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC } from '../pipeline.js';
import { evaluateRisk, sizeFromEquity } from '../risk.js';
import type { AccountSnapshot, MasterDecision, Quote } from '../types.js';

const quote: Quote = {
  bid: 2649.8,
  ask: 2650.2,
  mid: 2650,
  spread: 0.4,
  ts_ms: Date.now(),
};

const microAccount: AccountSnapshot = {
  equity: 44.28,
  balance: 44.28,
  currency: 'EUR',
  open_positions: 0,
  daily_pnl: -0.02,
  day_start_equity: 44.28,
  peak_equity: 10_000,
  consecutive_losses: 4,
};

const buyDecision: MasterDecision = {
  kind: 'BUY',
  side: 'BUY',
  decision_id: 'dec-micro',
  block_reason: null,
  analysis: null as never,
  buy: {
    side: 'BUY',
    valid: true,
    score: 0.9,
    components: {
      momentum: 0.8,
      trend: 0.8,
      structure: 0.8,
      pressure: 0.7,
      behavior: 0.6,
      impact: 0.7,
      context: 0.8,
    },
    entry: 2650.2,
    stop_loss: 2645,
    take_profit: 2660,
    filter_ok: true,
    filter_reason: null,
  },
  sell: {
    side: 'SELL',
    valid: false,
    score: 0.1,
    components: {
      momentum: 0.1,
      trend: 0.1,
      structure: 0.1,
      pressure: 0.1,
      behavior: 0.1,
      impact: 0.1,
      context: 0.1,
    },
    entry: 2649.8,
    stop_loss: 2655,
    take_profit: 2640,
    filter_ok: false,
    filter_reason: 'unused',
  },
};

describe('micro account risk relax', () => {
  afterEach(() => {
    delete process.env.MASTER_MICRO_ACCOUNT;
  });

  it('treats max_drawdown / daily / streak limit 0 as disabled', () => {
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      max_drawdown_pct: 0,
      max_daily_loss_pct: 0,
      consecutive_loss_limit: 0,
      cooldown_ms_after_loss: 0,
      fixed_lot: 0.01,
      risk_per_trade_pct: 0,
      max_spread_abs: 10,
    };
    const risk = evaluateRisk(buyDecision, microAccount, GOLD_SPEC, quote, cfg);
    expect(risk.reasons).not.toContain('max_drawdown');
    expect(risk.reasons).not.toContain('max_daily_loss');
    expect(risk.reasons).not.toContain('consecutive_loss_protection');
    expect(risk.allowed).toBe(true);
    expect(risk.volume).toBe(0.01);
  });

  it('default % gates still block micro equity + paper peak + streak 4', () => {
    const risk = evaluateRisk(
      buyDecision,
      microAccount,
      GOLD_SPEC,
      quote,
      DEFAULT_MASTER_CONFIG
    );
    expect(risk.allowed).toBe(false);
    expect(risk.reasons).toContain('max_drawdown');
    expect(risk.reasons).toContain('consecutive_loss_protection');
    expect(risk.reasons).toContain('volume_below_min');
  });

  it('applyMicroAccountConfig forces fixed lot and zero %-gates', () => {
    process.env.MASTER_MICRO_ACCOUNT = 'true';
    expect(isMicroAccountMode()).toBe(true);
    const cfg = applyMicroAccountConfig(DEFAULT_MASTER_CONFIG);
    expect(cfg.fixed_lot).toBe(0.01);
    expect(cfg.max_drawdown_pct).toBe(0);
    expect(cfg.max_daily_loss_pct).toBe(0);
    expect(cfg.consecutive_loss_limit).toBe(0);
    expect(cfg.cooldown_ms_after_loss).toBe(0);
    expect(cfg.reduce_lot_after_loss).toBe(false);

    const sized = sizeFromEquity(
      44.28,
      buyDecision.buy,
      GOLD_SPEC,
      cfg,
      { consecutive_losses: 4 }
    );
    expect(sized.allowed).toBe(true);
    expect(sized.volume).toBe(0.01);
    expect(sized.reasons).toContain('fixed_lot');

    const risk = evaluateRisk(buyDecision, microAccount, GOLD_SPEC, quote, cfg);
    expect(risk.allowed).toBe(true);
    expect(risk.reasons).not.toContain('max_drawdown');
    expect(risk.reasons).not.toContain('consecutive_loss_protection');
    expect(risk.reasons).not.toContain('volume_below_min');
  });

  it('reseedMicroAccountGates drops paper peak and loss streak', () => {
    process.env.MASTER_MICRO_ACCOUNT = '1';
    const account = { ...microAccount };
    expect(reseedMicroAccountGates(account)).toBe(true);
    expect(account.peak_equity).toBe(44.28);
    expect(account.day_start_equity).toBe(44.28);
    expect(account.consecutive_losses).toBe(0);
    expect(reseedMicroAccountGates(account)).toBe(false);
  });

  it('isMicroAccountMode off leaves config unchanged', () => {
    process.env.MASTER_MICRO_ACCOUNT = 'false';
    expect(isMicroAccountMode()).toBe(false);
    const cfg = applyMicroAccountConfig(DEFAULT_MASTER_CONFIG);
    expect(cfg).toEqual(DEFAULT_MASTER_CONFIG);
  });
});
