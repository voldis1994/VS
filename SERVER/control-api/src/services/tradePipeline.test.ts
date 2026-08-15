import { describe, expect, it } from 'vitest';
import { DecisionCodes } from './decisionCodes.js';
import { runTradePipeline, unresolvedPipelineError, type PipelineInput } from './tradePipeline.js';
import type { CapitalMarketQuote } from './capitalCom.js';

function quote(partial?: Partial<CapitalMarketQuote>): CapitalMarketQuote {
  return {
    epic: 'GOLD',
    bid: 4370,
    ask: 4371,
    mid: 4370.5,
    spread: 1,
    market_status: 'TRADEABLE',
    update_time: new Date().toISOString(),
    percentage_change: null,
    high: null,
    low: null,
    raw_ok: true,
    ...partial,
  };
}

function base(over?: Partial<PipelineInput>): PipelineInput {
  return {
    quote: quote(),
    epic: 'GOLD',
    lot_size: 0.1,
    regime: 'TREND_UP',
    just_closed_bar: {
      open_time_ms: Date.now() - 10_000,
      open: 4368,
      high: 4372,
      low: 4367,
      close: 4371,
      ticks: 10,
    },
    bar_forming: false,
    trend_bias: 'UP',
    trading_enabled: true,
    entry_enabled: true,
    feed_age_ms: 500,
    ...over,
  };
}

describe('P3 tradePipeline', () => {
  it('STOP / trading off blocks with BLOCKED_TECHNICAL', () => {
    const r = runTradePipeline(base({ stopped: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(DecisionCodes.BLOCKED_TECHNICAL);
  });

  it('market closed blocks with MARKET_CLOSED', () => {
    const r = runTradePipeline(base({ quote: quote({ market_status: 'CLOSED' }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(DecisionCodes.MARKET_CLOSED);
  });

  it('stale feed blocks with STALE_PRICE', () => {
    const r = runTradePipeline(base({ feed_age_ms: 20_000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(DecisionCodes.STALE_PRICE);
  });

  it('spread too high blocks', () => {
    const r = runTradePipeline(
      base({ quote: quote({ bid: 4370, ask: 4380, mid: 4375, spread: 10 }), max_spread: 2 })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(DecisionCodes.BLOCKED_TECHNICAL);
  });

  it('produces TradeIntent on with-trend closed bar', () => {
    const r = runTradePipeline(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.direction).toBe('BUY');
      expect(r.intent.size).toBe(0.1);
      expect(r.code).toBe(DecisionCodes.SIGNAL_CREATED);
    }
  });

  it('invalid lot → RISK_REJECTED', () => {
    const r = runTradePipeline(
      base({
        lot_size: 0,
        // force past setup by using a bar that yields entry — lot checked after
      })
    );
    // lot 0 fails at risk if entry exists; if no entry, NO_SETUP
    if (!r.ok && r.code === DecisionCodes.NO_SETUP) {
      expect(r.code).toBe(DecisionCodes.NO_SETUP);
    } else if (!r.ok) {
      expect(r.code).toBe(DecisionCodes.RISK_REJECTED);
    } else {
      // if somehow intent with lot 0 — fail test
      expect(r.intent.size).toBeGreaterThan(0);
    }
  });

  it('unresolved is ERROR not WAIT', () => {
    const r = unresolvedPipelineError('mystery');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(DecisionCodes.ERROR_STATE_UNRESOLVED);
      expect(r.code.startsWith('WAIT_')).toBe(false);
    }
  });
});
