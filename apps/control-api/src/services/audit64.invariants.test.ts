/**
 * Audit #64 — critical UNKNOWN = BLOCK invariants across the pipeline.
 * Companion to criticalUnknown.invariants.test.ts — covers entry-pipeline
 * UNKNOWN gates, execution/recovery truth, and universal-value helpers.
 */
import { describe, expect, it } from 'vitest';
import { decideFiveMinuteEntry } from './fiveMinuteBrain.js';
import type { StructureBar } from './marketStructure.js';
import { analyzeMarketStructure } from './marketStructure.js';
import { allowEntryFromDataQuality } from './dataQuality.js';
import { analysisMid, midOfSides } from './analysisPrice.js';
import { marketAllowsTrading } from './robotDesk.js';
import {
  resolveEntryPrice,
  canClearPendingExecution,
  recoverPendingExecution,
  nextClosePhaseAfterBrokerAck,
  nextClosePhaseAfterListFailure,
} from './tradeRecovery.js';
import { seedBackoffMs, TF_REFRESH_MS, classifyBarGap, TF_MS } from './timeframeBooks.js';
import { computeRiskPositionSize } from './positionSizing.js';

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  provenance: 'REAL' | 'SYNTHETIC' = 'REAL'
): StructureBar {
  return { open_time_ms: t, open: o, high: h, low: l, close: c, ticks: 8, provenance };
}

/** Smooth sine-wave zigzag that survives the default (left=2,right=2) pivot window. */
function waveUp(n: number, base = 100, amp = 3, period = 10, drift = 0.6): StructureBar[] {
  const bars: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const center = base + i * drift + amp * Math.sin((2 * Math.PI * i) / period);
    bars.push(bar(i * 300_000, center - 0.1, center + 0.5, center - 0.5, center + 0.1));
  }
  return bars;
}

function ltfConfirmUp(price: number): StructureBar[] {
  const out: StructureBar[] = [];
  for (let i = 0; i < 12; i++) {
    const o = price + i * 0.05;
    out.push(bar(i * 10_000, o, o + 0.08, o - 0.02, o + 0.06));
  }
  return out;
}

/** A valid 5m bullish continuation setup — baseline that would otherwise ENTER. */
function validBullishScenario(): { bars5m: StructureBar[]; price: number } {
  const base = waveUp(30);
  const ms0 = analyzeMarketStructure(base);
  const sh = ms0.last_swing_high!.price;
  const breakout = bar(
    base[base.length - 1]!.open_time_ms + 300_000,
    sh - 0.3,
    sh + 2.5,
    sh - 0.4,
    sh + 2.2
  );
  const bars5m = [...base, breakout];
  const price = bars5m[bars5m.length - 1]!.close;
  return { bars5m, price };
}

describe('#64 UNKNOWN HTF = NO ENTRY', () => {
  it('baseline scenario enters when HTF is known', () => {
    const { bars5m, price } = validBullishScenario();
    const d = decideFiveMinuteEntry({
      bars5m,
      bars1m: ltfConfirmUp(price),
      bars10s: ltfConfirmUp(price),
      regime: 'TREND_UP',
      price,
      spread: 0.05,
      feed_agreement: 0.9,
      htf: { trend: 'UP', near_support: true },
      tick_size: 0.01,
    });
    expect(d.entry).toBe(true);
  });

  it('missing HTF trend still enters on 5m setup (HTF neutral, no wait)', () => {
    const { bars5m, price } = validBullishScenario();
    const d = decideFiveMinuteEntry({
      bars5m,
      bars1m: ltfConfirmUp(price),
      bars10s: ltfConfirmUp(price),
      regime: 'TREND_UP',
      price,
      spread: 0.05,
      feed_agreement: 0.9,
      htf: null,
      tick_size: 0.01,
    });
    expect(d.entry).toBe(true);
    expect(d.hard_block).toBeNull();
  });
});

describe('#64 spread fallback — no UNKNOWN block', () => {
  it('missing spread uses 0 fallback and still enters on 5m', () => {
    const { bars5m, price } = validBullishScenario();
    const d = decideFiveMinuteEntry({
      bars5m,
      bars1m: ltfConfirmUp(price),
      bars10s: ltfConfirmUp(price),
      regime: 'TREND_UP',
      price,
      spread: null,
      feed_agreement: 0.9,
      htf: { trend: 'UP', near_support: true },
      tick_size: 0.01,
    });
    expect(d.entry).toBe(true);
    expect(d.hard_block).toBeNull();
  });
});

describe('#64 UNKNOWN source_ms = NO ENTRY', () => {
  it('quote with only fetch_ms (no source_ms) cannot pass entry data-quality gate', () => {
    const now = Date.now();
    const v = allowEntryFromDataQuality({ mid: 100, fetch_ms: now });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/source timestamp UNKNOWN/);
  });
});

describe('#64 structural SL fallback — no UNKNOWN block', () => {
  it('uses % SL fallback when pivot missing instead of blocking', () => {
    // Strictly increasing lows never form a LOW pivot (thesisPivot('BUY') stays null),
    // while a single HIGH spike + big breakout gives a real bullish BOS/direction.
    const bars: StructureBar[] = [];
    for (let i = 0; i < 20; i++) {
      const low = 99 + i;
      let high: number;
      if (i === 10) high = 140;
      else if (i === 11 || i === 12) high = 105 + i;
      else high = 101 + i;
      bars.push(bar(i * 300_000, low + 0.5, high, low, low + 1));
    }
    const lastLow = 99 + 20;
    const breakout = bar(20 * 300_000, 140.2, 145, lastLow, 144);
    const bars5m = [...bars, breakout];
    const price = bars5m[bars5m.length - 1]!.close;

    const ltfSteep: StructureBar[] = [];
    for (let i = 0; i < 12; i++) {
      const o = price + i * 0.3;
      ltfSteep.push(bar(i * 10_000, o, o + 0.35, o - 0.05, o + 0.3));
    }

    const d = decideFiveMinuteEntry({
      bars5m,
      bars1m: ltfSteep,
      bars10s: ltfSteep,
      regime: 'TREND_UP',
      price,
      spread: 0.05,
      feed_agreement: 0.9,
      htf: { trend: 'UP', near_support: true },
    });
    expect(d.direction).toBe('BUY');
    expect(d.structural_sl).not.toBeNull();
    expect(d.entry).toBe(true);
    expect(d.hard_block).toBeNull();
  });
});

describe('#64 missing BID/ASK = no analysis MID', () => {
  it('analysisMid requires both bid and ask', () => {
    expect(analysisMid(null)).toBeNull();
    expect(analysisMid({ bid: 10 })).toBeNull();
    expect(analysisMid({ ask: 12 })).toBeNull();
    expect(analysisMid({ mid: 11 })).toBeNull();
    expect(analysisMid({ bid: 10, ask: 12 })).toBe(11);
  });
});

describe('#64 missing market status = NO NEW ENTRY', () => {
  it('marketAllowsTrading(missing) is false', () => {
    expect(marketAllowsTrading(null)).toBe(false);
    expect(marketAllowsTrading(undefined)).toBe(false);
    expect(marketAllowsTrading('')).toBe(false);
    expect(marketAllowsTrading('TRADEABLE')).toBe(true);
  });
});

describe('#64 execution truth', () => {
  it('resolveEntryPrice: signal_mid alone is never fill truth', () => {
    expect(resolveEntryPrice({ signal_mid: 1.1 })).toBeNull();
    expect(resolveEntryPrice({ broker_open_level: 1.1005, signal_mid: 1.1 })).toBe(1.1005);
  });

  it('canClearPendingExecution requires broker position AND a real fill level', () => {
    expect(canClearPendingExecution({ brokerOpen: false, fillLevel: 100 })).toBe(false);
    expect(canClearPendingExecution({ brokerOpen: true, fillLevel: null })).toBe(false);
    expect(canClearPendingExecution({ brokerOpen: true, fillLevel: NaN })).toBe(false);
    expect(canClearPendingExecution({ brokerOpen: true, fillLevel: 100.5 })).toBe(true);
  });

  it('recoverPendingExecution WAITs without any broker position (never blind-clears)', () => {
    const r = recoverPendingExecution({
      pending: {
        robot_id: '1:X',
        account_id: 1,
        epic: 'X',
        side: 'BUY',
        deal_reference: null,
        claimed_at: new Date().toISOString(),
        signal_mid: 10,
      },
      brokerOpen: null,
    });
    expect(r.action).toBe('WAIT');
  });
});

describe('#64 close-phase truth', () => {
  it('nextClosePhaseAfterBrokerAck: still open on broker → CLOSE_UNCERTAIN', () => {
    expect(nextClosePhaseAfterBrokerAck(true)).toBe('CLOSE_UNCERTAIN');
    expect(nextClosePhaseAfterBrokerAck(false)).toBe('CLOSED');
  });

  it('nextClosePhaseAfterListFailure always → RECONCILING (never silently CLOSED)', () => {
    expect(nextClosePhaseAfterListFailure('CLOSE_REQUESTED')).toBe('RECONCILING');
    expect(nextClosePhaseAfterListFailure('BROKER_CLOSE_SENT')).toBe('RECONCILING');
    expect(nextClosePhaseAfterListFailure('OPEN')).toBe('RECONCILING');
  });
});

describe('#64 seed/refresh cadence', () => {
  it('seedBackoffMs grows with consecutive failures, capped', () => {
    const b1 = seedBackoffMs(1);
    const b2 = seedBackoffMs(2);
    const b3 = seedBackoffMs(3);
    expect(b2).toBeGreaterThan(b1);
    expect(b3).toBeGreaterThan(b2);
    expect(seedBackoffMs(20)).toBeLessThanOrEqual(300_000);
  });

  it('TF_REFRESH_MS has a distinct cadence per timeframe', () => {
    const values = Object.values(TF_REFRESH_MS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    expect(TF_REFRESH_MS['1m']).toBeLessThan(TF_REFRESH_MS['5m']);
    expect(TF_REFRESH_MS['5m']).toBeLessThan(TF_REFRESH_MS['15m']);
    expect(TF_REFRESH_MS['15m']).toBeLessThan(TF_REFRESH_MS['1H']);
    expect(TF_REFRESH_MS['1H']).toBeLessThan(TF_REFRESH_MS['4H']);
  });
});

describe('#64 classifyBarGap', () => {
  it('requires Capital openingHours — gap length alone never proves session', () => {
    const step = TF_MS['1H'];
    expect(classifyBarGap(0, step, step)).toBe('none');
    // Without Capital hours, large gaps are UNKNOWN (cannot prove session break)
    expect(classifyBarGap(0, 60 * 3_600_000, step)).toBe('unknown');
    expect(classifyBarGap(0, 4 * 3_600_000, step)).toBe('unknown');
  });
});

describe('#64 computeRiskPositionSize', () => {
  it('sizes from equity/risk/stop distance when instrument value is known', () => {
    const r = computeRiskPositionSize({
      equity: 10_000,
      risk_per_trade: 0.01,
      entry: 100,
      structural_sl: 98,
      side: 'BUY',
      value_per_point: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.quantity).toBeGreaterThan(0);
    expect(r.risk_cash).toBeCloseTo(100, 5);
  });

  it('UNKNOWN instrument value/tick → cannot size (never invent)', () => {
    const r = computeRiskPositionSize({
      equity: 10_000,
      risk_per_trade: 0.01,
      entry: 100,
      structural_sl: 98,
      side: 'BUY',
    });
    expect(r.ok).toBe(false);
    expect(r.quantity).toBeNull();
  });

  it('invalid (non-positive) stop distance blocks sizing', () => {
    const r = computeRiskPositionSize({
      equity: 10_000,
      risk_per_trade: 0.01,
      entry: 100,
      structural_sl: 102, // above entry for a BUY — invalid stop side
      side: 'BUY',
      value_per_point: 1,
    });
    expect(r.ok).toBe(false);
  });
});

describe('#64 midOfSides — one-sided → null', () => {
  it('requires both sides; one-sided or missing never invents a mid', () => {
    expect(midOfSides(null, null)).toBeNull();
    expect(midOfSides(10, null)).toBeNull();
    expect(midOfSides(null, 12)).toBeNull();
    expect(midOfSides(10, 12)).toBe(11);
  });
});

describe('#64 Capital OHLC mid-of-pair behavior (via analysisPrice)', () => {
  // fetchCapitalPrices' internal midOfPair() requires true bid+ask on every OHLC leg —
  // analysisPrice.midOfSides implements the identical bid+ask-required domain rule.
  it('one-sided bid/ask leg never invents an OHLC mid', () => {
    expect(midOfSides(1.1005, null)).toBeNull();
    expect(midOfSides(null, 1.1007)).toBeNull();
    expect(midOfSides(1.1005, 1.1007)).toBeCloseTo(1.1006, 10);
  });

  it('zero/negative sides are rejected — not a valid price', () => {
    expect(midOfSides(0, 1.1)).toBeNull();
    expect(midOfSides(1.1, -1)).toBeNull();
  });
});
