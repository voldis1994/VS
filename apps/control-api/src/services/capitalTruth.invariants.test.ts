/**
 * CAPITAL DATA = SOURCE OF TRUTH · VS = INTELLIGENCE LAYER
 * Regression: LIVE entry/execution/recovery must not invent Capital fields.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractCapitalPointSize } from './capitalCom.js';
import { analysisMid, midOfSides } from './analysisPrice.js';
import { marketAllowsTrading } from './robotDesk.js';
import { parseCapitalOpeningHours, classifyBarGapWithOpeningHours } from './tradingSessions.js';
import { resolveEntryPrice } from './tradeRecovery.js';
import { computeInstrumentSafetyStop } from './safetyStop.js';
import { TF_MS } from './timeframeBooks.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('Capital truth — marketStatus', () => {
  it('OPEN/TRADEABLE allow; CLOSED/SUSPENDED/UNKNOWN/missing block', () => {
    expect(marketAllowsTrading('TRADEABLE')).toBe(true);
    expect(marketAllowsTrading('OPEN')).toBe(true);
    expect(marketAllowsTrading('CLOSED')).toBe(false);
    expect(marketAllowsTrading('SUSPENDED')).toBe(false);
    expect(marketAllowsTrading('UNKNOWN')).toBe(false);
    expect(marketAllowsTrading(null)).toBe(false);
    expect(marketAllowsTrading('')).toBe(false);
  });

  it('desk does not invent status from clock/EPIC (source)', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/marketAllowsTrading\(quote\.market_status\)/);
    expect(src).not.toMatch(/sessionMetaForEpic/);
  });
});

describe('Capital truth — openingHours + timezone', () => {
  it('hours without Capital timezone → null (UNKNOWN)', () => {
    const raw = {
      monday: [{ openTime: '07:00', closeTime: '21:00' }],
    };
    expect(parseCapitalOpeningHours(raw)).toBeNull();
    expect(parseCapitalOpeningHours(raw, { timezone: null })).toBeNull();
    expect(parseCapitalOpeningHours(raw, { timezone: 'UTC' })).not.toBeNull();
  });

  it('excess gap without hours → unknown; never from gap length alone', () => {
    expect(
      classifyBarGapWithOpeningHours(0, 60 * 3_600_000, TF_MS['1H'], null)
    ).toBe('unknown');
  });
});

describe('Capital truth — instrument point_size / min stop', () => {
  it('extractCapitalPointSize never invents from mid magnitude', () => {
    expect(extractCapitalPointSize({})).toBeNull();
    expect(extractCapitalPointSize({ snapshot: {} })).toBeNull();
    // Magnitude buckets removed — high mid alone is not enough
    expect(extractCapitalPointSize({ snapshot: { /* no decimalPlaces */ } })).toBeNull();
  });

  it('uses Capital decimalPlacesFactor', () => {
    expect(
      extractCapitalPointSize({ snapshot: { decimalPlacesFactor: 2 } })
    ).toBeCloseTo(0.01, 10);
    expect(
      extractCapitalPointSize({
        instrument: { decimalPlacesFactor: 4 },
        snapshot: { scalingFactor: 1 },
      })
    ).toBeCloseTo(0.0001, 10);
  });

  it('uses Capital minStepDistance when present', () => {
    expect(
      extractCapitalPointSize({
        dealingRules: { minStepDistance: { value: 0.1, unit: 'POINTS' } },
      })
    ).toBeCloseTo(0.1, 10);
  });

  it('Safety SL BLOCKS without Capital minStopDistance', () => {
    const r = computeInstrumentSafetyStop({
      direction: 'BUY',
      mid: 4660,
      bid: 4659.8,
      ask: 4660.2,
      tickSize: 0.01,
      pointSize: 0.01,
      // minStopDistance missing
    });
    expect(r.ok).toBe(false);
    expect(r.stop_level).toBeNull();
    expect(r.detail).toMatch(/minStop/i);
  });

  it('Safety SL OK when Capital minStopDistance present', () => {
    const r = computeInstrumentSafetyStop({
      direction: 'BUY',
      mid: 4660,
      bid: 4659.8,
      ask: 4660.2,
      minStopDistance: 0.5,
      tickSize: 0.01,
      pointSize: 0.01,
    });
    expect(r.ok).toBe(true);
    expect(r.stop_level).not.toBeNull();
    expect(r.stop_level!).toBeLessThan(4660);
  });
});

describe('Capital truth — live BID/ASK mid', () => {
  it('analysis MID requires both sides', () => {
    expect(analysisMid({ bid: 10, ask: null })).toBeNull();
    expect(analysisMid({ bid: null, ask: 12 })).toBeNull();
    expect(analysisMid({ mid: 11 })).toBeNull();
    expect(analysisMid({ bid: 10, ask: 12 })).toBe(11);
    expect(midOfSides(10, null)).toBeNull();
  });

  it('fetchCapitalMarketQuote mid path rejects lastTraded invent (source)', () => {
    const src = readFileSync(join(here, 'capitalCom.ts'), 'utf8');
    expect(src).toMatch(/BID\+ASK only/);
    expect(src).not.toMatch(/else mid = numOrNull\(snap\.mid ?? snap\.lastTraded\)/);
    expect(src).toMatch(/extractCapitalPointSize/);
    expect(src).not.toMatch(/m >= 1000/);
  });
});

describe('Capital truth — execution fill', () => {
  it('resolveEntryPrice never uses signal mid', () => {
    expect(resolveEntryPrice({ signal_mid: 100 })).toBeNull();
    expect(resolveEntryPrice({ broker_open_level: 101, signal_mid: 100 })).toBe(101);
    expect(resolveEntryPrice({ confirm_level: 100.5, signal_mid: 100 })).toBe(100.5);
  });

  it('robotDesk never seeds entry from quote.mid (source)', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).not.toMatch(/entry_price\s*=\s*existing\.open_level\s*\?\?\s*quote\.mid/);
    expect(src).not.toMatch(/entry_price\s*\?\?\s*quote\.mid\s*\?\?\s*0/);
    expect(src).toMatch(/size:\s*s\.lot_size/);
    expect(src).not.toMatch(/computeRiskPositionSize\(/);
  });
});

describe('Capital truth — realized PnL / close', () => {
  it('exitTrade notes PnL only from Capital confirm; skips invent (source)', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/fetchCapitalConfirmedProfit/);
    expect(src).toMatch(/RISK PnL UNKNOWN · skipped noteRiskTradePnl/);
    expect(src).toMatch(/Broker-confirmed realized only|wasLoss = realizedGot\.profit/);
  });
});

describe('Capital truth — native HTF primary', () => {
  it('seedMultiTf prefers native Capital; agg only when native EMPTY (source)', () => {
    const src = readFileSync(join(here, 'seedMultiTf.ts'), 'utf8');
    expect(src).toMatch(/native Capital resolution is primary/);
    expect(src).toMatch(/fetchCapitalOpeningHours/);
    expect(src).not.toMatch(/sessionMetaForEpic/);
  });
});
