/**
 * Market intelligence core — no fake prices, no look-ahead, operational blocks.
 */
import { describe, it, expect } from 'vitest';
import {
  validateMultiFeed,
  rawTickFromParts,
  ingestTickTo10s,
  emptyOhlc10sState,
  aggregateFrom10s,
  candlesAvailableAt,
  candle10sBucketStartMs,
  buildMarketStateVector,
  evaluateTrendContinuationSetup,
  computeProtectiveStop,
  computeLotSize,
  canTransitionOrder,
  transitionOrder,
  updateExcursion,
  rankExitCandidates,
  buildTradeExplanation,
  type Candle10s,
  type RawTickEvent,
} from '../../SERVER/core/market-intelligence/src/index.ts';
import { confirmEntry } from '../../SERVER/core/strategies/trend_continuation/entry.ts';

function tick(
  provider: string,
  mid: number,
  ts: string,
  spread = 0.2
): RawTickEvent {
  const bid = mid - spread / 2;
  const ask = mid + spread / 2;
  const t = rawTickFromParts({
    provider,
    instrument: 'XAUUSD',
    bid,
    ask,
    timestamp_source: ts,
    timestamp_receive: ts,
  });
  if (!t) throw new Error('bad tick');
  return t;
}

describe('multi-feed validation', () => {
  it('blocks when no feeds', () => {
    const r = validateMultiFeed({ instrument: 'XAUUSD', ticks: [] });
    expect(r.block).toBe('FEED_UNAVAILABLE');
    expect(r.trading_price).toBeNull();
  });

  it('uses median mid and never invents missing providers', () => {
    const ts = '2026-01-01T12:00:05.000Z';
    const r = validateMultiFeed({
      instrument: 'XAUUSD',
      expectedProviders: ['A', 'B', 'C'],
      ticks: [tick('A', 2000, ts), tick('B', 2000.2, ts)],
    });
    expect(r.missing_providers).toEqual(['C']);
    expect(r.median_mid).toBeCloseTo(2000.1, 5);
    expect(r.provenance).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('DATA_QUALITY_BLOCK on large disagreement', () => {
    const ts = '2026-01-01T12:00:05.000Z';
    const r = validateMultiFeed({
      instrument: 'XAUUSD',
      maxRelativeDisagreement: 0.0001,
      ticks: [tick('A', 2000, ts), tick('B', 2010, ts)],
    });
    expect(r.quote_disagreement).toBe(true);
    expect(r.block).toBe('DATA_QUALITY_BLOCK');
    expect(r.trading_price).toBeNull();
  });
});

describe('canonical 10s OHLC', () => {
  it('uses deterministic UTC buckets', () => {
    const ms = Date.parse('2026-01-01T12:00:17.123Z');
    expect(candle10sBucketStartMs(ms)).toBe(Date.parse('2026-01-01T12:00:10.000Z'));
  });

  it('closes candle on boundary without inventing empty bars', () => {
    let state = emptyOhlc10sState('XAUUSD');
    const t0 = tick('A', 100, '2026-01-01T12:00:01.000Z');
    let r = ingestTickTo10s(state, t0);
    state = r.state;
    expect(r.closed).toBeNull();
    const t1 = tick('A', 101, '2026-01-01T12:00:11.000Z');
    r = ingestTickTo10s(state, t1);
    expect(r.closed).not.toBeNull();
    expect(r.closed!.open).toBe(100);
    expect(r.closed!.close).toBe(100);
    expect(r.closed!.tick_count).toBe(1);
  });

  it('candlesAvailableAt enforces no look-ahead', () => {
    const c: Candle10s = {
      instrument: 'XAUUSD',
      start_ts: '2026-01-01T12:00:00.000Z',
      end_ts: '2026-01-01T12:00:10.000Z',
      open: 1,
      high: 2,
      low: 1,
      close: 2,
      tick_count: 3,
      bid_open: 1,
      bid_high: 2,
      bid_low: 1,
      bid_close: 2,
      ask_open: 1.1,
      ask_high: 2.1,
      ask_low: 1.1,
      ask_close: 2.1,
      spread_min: 0.1,
      spread_max: 0.1,
      spread_mean: 0.1,
      source_count: 1,
      quality_score: 1,
      provenance: ['A'],
    };
    expect(candlesAvailableAt([c], '2026-01-01T12:00:09.999Z')).toHaveLength(0);
    expect(candlesAvailableAt([c], '2026-01-01T12:00:10.000Z')).toHaveLength(1);
  });

  it('aggregates 10s → 30s', () => {
    const bars: Candle10s[] = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.parse('2026-01-01T12:00:00.000Z') + i * 10_000;
      bars.push({
        instrument: 'XAUUSD',
        start_ts: new Date(start).toISOString(),
        end_ts: new Date(start + 10_000).toISOString(),
        open: 100 + i,
        high: 110 + i,
        low: 90 + i,
        close: 105 + i,
        tick_count: 2,
        bid_open: 100,
        bid_high: 110,
        bid_low: 90,
        bid_close: 105,
        ask_open: 100.2,
        ask_high: 110.2,
        ask_low: 90.2,
        ask_close: 105.2,
        spread_min: 0.2,
        spread_max: 0.2,
        spread_mean: 0.2,
        source_count: 1,
        quality_score: 1,
        provenance: ['A'],
      });
    }
    const agg = aggregateFrom10s(bars, 30);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.open).toBe(100);
    expect(agg[0]!.close).toBe(107);
  });
});

describe('market state vector', () => {
  it('returns INSUFFICIENT_DATA instead of fake FLAT', () => {
    const v = buildMarketStateVector({
      instrument: 'XAUUSD',
      candles: [],
      asOf: new Date().toISOString(),
    });
    expect(v.status).toBe('FEED_UNAVAILABLE');
    expect(v.label).toBeNull();
    expect(v.direction_score).toBeNull();
  });

  it('computes measurements from enough closed bars', () => {
    const candles: Candle10s[] = [];
    const base = Date.parse('2026-01-01T12:00:00.000Z');
    for (let i = 0; i < 40; i++) {
      const start = base + i * 10_000;
      const px = 2000 + i * 0.5;
      candles.push({
        instrument: 'XAUUSD',
        start_ts: new Date(start).toISOString(),
        end_ts: new Date(start + 10_000).toISOString(),
        open: px,
        high: px + 0.3,
        low: px - 0.2,
        close: px + 0.1,
        tick_count: 5,
        bid_open: px,
        bid_high: px + 0.3,
        bid_low: px - 0.2,
        bid_close: px + 0.1,
        ask_open: px + 0.2,
        ask_high: px + 0.5,
        ask_low: px,
        ask_close: px + 0.3,
        spread_min: 0.2,
        spread_max: 0.2,
        spread_mean: 0.2,
        source_count: 1,
        quality_score: 1,
        provenance: ['A'],
      });
    }
    const asOf = candles[candles.length - 1]!.end_ts;
    const v = buildMarketStateVector({
      instrument: 'XAUUSD',
      candles,
      asOf,
      feedConfidence: 0.9,
      spreadQuality: 0.8,
    });
    expect(v.status).toBe('OK');
    expect(v.direction_score).not.toBeNull();
    expect(v.trend_strength).not.toBeNull();
    expect(v.inputs.atr).not.toBeNull();
    // Label may be null — that is OK; measurements exist
    expect(v).not.toMatchObject({ label: 'UNKNOWN' });
  });
});

describe('setup + protective stop + lot', () => {
  it('never opens on regime label alone — conditions must PASS', () => {
    const market = buildMarketStateVector({
      instrument: 'XAUUSD',
      candles: [],
      asOf: new Date().toISOString(),
    });
    const setup = evaluateTrendContinuationSetup({
      market,
      feed: { quality: 'OK', trading_price: 2000, block: null, detail: 'ok' },
    });
    expect(setup.all_pass).toBe(false);
    expect(setup.block).toBeTruthy();
    expect(confirmEntry(setup).ok).toBe(false);
  });

  it('blocks SL beyond emergency ceiling', () => {
    const sl = computeProtectiveStop({
      direction: 'LONG',
      entry: 100,
      structureLevel: 10, // absurd distance
      emergencyCeilingPct: 0.2,
    });
    expect(sl.ok).toBe(false);
    if (!sl.ok) expect(sl.block).toBe('EMERGENCY_SL_CEILING');
  });

  it('ATR stop is market-based not hardcoded pips', () => {
    const sl = computeProtectiveStop({
      direction: 'LONG',
      entry: 2000,
      atr: 2,
      atrMultiplier: 1.5,
      spread: 0.2,
    });
    expect(sl.ok).toBe(true);
    if (sl.ok) {
      expect(sl.sl_method).toBe('ATR');
      expect(sl.sl_price).toBeLessThan(2000);
      expect(sl.calculation_inputs.atr).toBe(2);
    }
  });

  it('lot respects instrument bounds', () => {
    const lot = computeLotSize({
      policy: { mode: 'FIXED', lot: 0.123 },
      instrument: { min_lot: 0.01, max_lot: 5, lot_step: 0.01 },
    });
    expect(lot.ok).toBe(true);
    if (lot.ok) expect(lot.lot).toBe(0.12);
  });
});

describe('order lifecycle + exit', () => {
  it('enforces OSM transitions', () => {
    expect(canTransitionOrder('SETUP', 'ENTRY_PENDING')).toBe(true);
    expect(canTransitionOrder('SETUP', 'FILLED')).toBe(false);
    const t = transitionOrder({ from: 'SETUP', to: 'ENTRY_PENDING', reason: 'setup_pass' });
    expect(t.ok).toBe(true);
  });

  it('ranks exits without look-ahead future prices', () => {
    const ex = updateExcursion({
      entry: 100,
      direction: 'LONG',
      current: 101,
      peak_price: 102,
      mfe: 2,
      mae: 0,
    });
    expect(ex.giveback).toBeGreaterThan(0);
    const ranked = rankExitCandidates({
      excursion: ex,
      momentum_score: -0.5,
      structure_deteriorating: true,
      spread_deteriorating: false,
    });
    expect(ranked[0]!.action).toBeTruthy();
  });
});

describe('explainability', () => {
  it('builds trade explanation with calculations', () => {
    const market = {
      instrument: 'XAUUSD',
      as_of: new Date().toISOString(),
      direction_score: 0.5,
      trend_strength: 0.6,
      trend_quality: 0.5,
      volatility_percentile: 0.4,
      compression_score: 0.1,
      expansion_score: 0.2,
      momentum_score: 0.3,
      structure_score: 0.5,
      breakout_score: 0.1,
      reversal_pressure: 0,
      noise_score: 0.3,
      liquidity_score: 0.8,
      spread_quality: 0.8,
      feed_confidence: 0.9,
      label: 'TREND_UP' as string | null,
      inputs: { bar_count: 40, atr: 1.5, slope: 0.01, r_squared: 0.5, hh_hl_lh_ll: 'HH_HL' },
      status: 'OK' as const,
    };
    const setup = evaluateTrendContinuationSetup({
      market,
      feed: { quality: 'OK', trading_price: 2000, block: null, detail: 'ok' },
    });
    const sl = computeProtectiveStop({
      direction: 'LONG',
      entry: 2000,
      atr: 1.5,
    });
    const lot = computeLotSize({
      policy: { mode: 'FIXED', lot: 0.1 },
      instrument: { min_lot: 0.01, max_lot: 10, lot_step: 0.01 },
    });
    const expl = buildTradeExplanation({
      trade_id: 't1',
      setup,
      market,
      sl,
      lot,
    });
    expect(expl.entry.calculations).toBeTruthy();
    expect(expl.market.direction_score).toBe(0.5);
  });
});
