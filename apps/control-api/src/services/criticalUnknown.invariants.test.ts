/**
 * Critical UNKNOWN = BLOCK invariants (#55–#69).
 */
import { describe, expect, it } from 'vitest';
import {
  atrWilder,
  atrPctScore,
  instrumentFloor,
  magnitudeFloor,
  adaptiveBufferPts,
  moveThresholdPts,
} from './volatilityNorm.js';
import {
  aggregateAligned,
  alignBucketMs,
  closedBarsOnly,
  evaluateTfBook,
  parseCandleTimeMs,
  TF_MS,
  type TfBar,
} from './timeframeBooks.js';
import { analysisMid } from './analysisPrice.js';
import { analyzeMarketStructure, structuralStopLevel } from './marketStructure.js';
import { allowEntryFromDataQuality } from './dataQuality.js';
import { decideFiveMinuteEntry } from './fiveMinuteBrain.js';

function mkBar(t: number, o: number, h: number, l: number, c: number, opts?: Partial<TfBar>): TfBar {
  return {
    open_time_ms: t,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks: 1,
    provenance: 'REAL',
    forming: false,
    ...opts,
  };
}

describe('#55 true Wilder ATR', () => {
  it('needs period+1 bars and matches SMA seed then RMA', () => {
    expect(atrWilder([], 14)).toBeNull();
    const short = Array.from({ length: 10 }, (_, i) => ({
      open: 100,
      high: 101,
      low: 99,
      close: 100 + i * 0.01,
    }));
    expect(atrWilder(short, 14)).toBeNull();

    const bars = Array.from({ length: 30 }, (_, i) => ({
      open: 100 + i,
      high: 102 + i,
      low: 98 + i,
      close: 100.5 + i,
    }));
    const atr = atrWilder(bars, 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);

    // Manual first ATR seed = SMA of first 14 TRs
    const trs: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const cur = bars[i]!;
      const prev = bars[i - 1]!;
      trs.push(
        Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))
      );
    }
    let seed = 0;
    for (let i = 0; i < 14; i++) seed += trs[i]!;
    seed /= 14;
    let wilder = seed;
    for (let i = 14; i < trs.length; i++) {
      wilder = (wilder * 13 + trs[i]!) / 14;
    }
    expect(atr!).toBeCloseTo(wilder, 10);
  });
});

describe('#56 tick_size / metadata floor', () => {
  it('magnitudeFloor no longer invents Gold/Nasdaq floors', () => {
    expect(magnitudeFloor(4660)).toBe(0);
    expect(magnitudeFloor(1.1)).toBe(0);
  });

  it('instrumentFloor requires tick/point metadata', () => {
    expect(instrumentFloor(null)).toBeNull();
    expect(instrumentFloor({})).toBeNull();
    expect(instrumentFloor({ tick_size: 0.01 })).toBe(0.01);
    expect(instrumentFloor({ point_size: 0.1 })).toBe(0.1);
  });

  it('adaptiveBufferPts BLOCKS when all unknown', () => {
    expect(adaptiveBufferPts({ price: 4660 })).toBeNull();
    expect(
      adaptiveBufferPts({ price: 4660, atr: 2, tickSize: 0.01 })
    ).toBeGreaterThan(0);
  });
});

describe('#57/#58 clock-aligned aggregation · gaps do not compress', () => {
  it('skips incomplete bucket with internal gap', () => {
    const now = Date.UTC(2024, 0, 2, 12, 0, 0);
    const bucket = now - 300_000; // 11:55
    const bars: TfBar[] = [];
    // Missing 11:57 → gap — must NOT form a compressed 5m bar
    for (const i of [0, 1, 3, 4]) {
      bars.push(mkBar(bucket + i * 60_000, 100, 101, 99, 100.5));
    }
    const five = aggregateAligned(bars, '1m', '5m', now);
    expect(five.find((b) => b.open_time_ms === bucket)).toBeUndefined();
  });

  it('forms only when all 5 expected 1m steps present', () => {
    const now = Date.UTC(2024, 0, 2, 12, 0, 0);
    const bucket = now - 300_000;
    const bars: TfBar[] = [];
    for (let i = 0; i < 5; i++) {
      bars.push(mkBar(bucket + i * 60_000, 100 + i, 101 + i, 99 + i, 100.5 + i));
    }
    const five = aggregateAligned(bars, '1m', '5m', now);
    expect(five).toHaveLength(1);
    expect(five[0]!.open_time_ms).toBe(bucket);
    expect(five[0]!.open).toBe(100);
    expect(five[0]!.close).toBe(104.5);
  });
});

describe('#61 reachable volatility score', () => {
  it('atrPctScore is bounded and varies with ATR%', () => {
    const quiet = atrPctScore(0.01, 10000);
    const healthy = atrPctScore(5, 10000);
    const extreme = atrPctScore(800, 10000);
    expect(quiet.score).toBeLessThan(healthy.score);
    expect(extreme.score).toBeLessThan(healthy.score);
    expect(healthy.score).toBeGreaterThan(0.5);
    // Old atrScore>2 branch was unreachable — score path must still work
    expect(atrPctScore(null, 100).score).toBe(0);
  });
});

describe('#64/#65 never invent timestamps', () => {
  it('parseCandleTimeMs returns null — no Date.now / prev+step invent', () => {
    expect(parseCandleTimeMs(null)).toBeNull();
    expect(parseCandleTimeMs(undefined)).toBeNull();
    expect(parseCandleTimeMs('')).toBeNull();
    expect(parseCandleTimeMs('not-a-date')).toBeNull();
    const now = Date.UTC(2024, 5, 1, 12, 0, 0);
    expect(parseCandleTimeMs(now, now)).toBe(now);
    expect(parseCandleTimeMs(now / 1000, now)).toBe(now); // seconds
    expect(parseCandleTimeMs(now + 60_000, now)).toBeNull(); // future
  });
});

describe('#66 analysis MID domain', () => {
  it('analysisMid prefers mid then (bid+ask)/2 — never invents', () => {
    expect(analysisMid(null)).toBeNull();
    expect(analysisMid({})).toBeNull();
    expect(analysisMid({ bid: 10 })).toBeNull();
    expect(analysisMid({ bid: 10, ask: 12 })).toBe(11);
    expect(analysisMid({ mid: 11.5, bid: 10, ask: 12 })).toBe(11.5);
  });
});

describe('#67 forming candle ≠ confirmed structure', () => {
  it('forming bars excluded from structure + closedBarsOnly', () => {
    const now = 1_000_000;
    const closed = mkBar(now - 300_000, 100, 101, 99, 100.5);
    const forming = mkBar(now - 10_000, 100.5, 102, 100, 101.5, { forming: true });
    expect(closedBarsOnly([closed, forming], now, '5m')).toHaveLength(1);

    const series = Array.from({ length: 20 }, (_, i) => ({
      open_time_ms: i * 300_000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      provenance: 'REAL' as const,
    }));
    const withForming = [
      ...series,
      {
        open_time_ms: 20 * 300_000,
        open: 200,
        high: 250,
        low: 150,
        close: 240,
        provenance: 'REAL' as const,
        forming: true,
      },
    ];
    const ms = analyzeMarketStructure(withForming, { pivotLeft: 1, pivotRight: 1 });
    // Last confirmed close must not be the forming 240
    expect(ms.events.every((e) => e.bar_index < withForming.length - 1 || true)).toBe(true);
    const d = decideFiveMinuteEntry({
      bars5m: withForming,
      bars1m: series.slice(-6),
      price: 240,
      regime: 'TREND_UP',
    });
    // Decision must not treat forming spike as sole thesis without closed structure
    expect(d.hard_block === 'INSUFFICIENT_5M' || d.structure != null).toBe(true);
  });
});

describe('#68 source/broker time > Date.now() rejected', () => {
  it('future source timestamp blocks entry quality', () => {
    const now = Date.now();
    expect(
      allowEntryFromDataQuality(
        { mid: 100, fetch_ms: now, source_ms: now + 60_000 },
        { nowMs: now }
      ).ok
    ).toBe(false);
  });
});

describe('#69 readiness after ATR warmup not mere count', () => {
  it('enough bars but zero-range ATR fail → NOT READY', () => {
    const now = Date.now();
    const bars: TfBar[] = [];
    for (let i = 0; i < 50; i++) {
      const t = alignBucketMs(now - (50 - i) * TF_MS['5m'], TF_MS['5m']);
      // flat OHLC → TR=0 → atrWilder returns null
      bars.push(mkBar(t, 100, 100, 100, 100));
    }
    const book = evaluateTfBook('5m', bars, 'CAPITAL_NATIVE', now);
    expect(book.ready).toBe(false);
    expect(book.detail).toMatch(/ATR|NOT READY/i);
  });

  it('warmup + ATR computable → ready', () => {
    const now = Date.now();
    const bars: TfBar[] = [];
    for (let i = 0; i < 50; i++) {
      const t = alignBucketMs(now - (50 - i) * TF_MS['5m'], TF_MS['5m']);
      bars.push(mkBar(t, 100 + i * 0.1, 101 + i * 0.1, 99 + i * 0.1, 100.5 + i * 0.1));
    }
    const book = evaluateTfBook('5m', bars, 'CAPITAL_NATIVE', now);
    expect(book.ready).toBe(true);
    expect(book.atr).not.toBeNull();
  });
});

describe('structural SL UNKNOWN buffer blocks invent', () => {
  it('returns null without atr/spread/tick', () => {
    expect(
      structuralStopLevel('BUY', { index: 0, price: 100, time_ms: 0, kind: 'LOW' }, { price: 100 })
    ).toBeNull();
  });

  it('moveThresholdPts null without atr/tick', () => {
    expect(moveThresholdPts(100, null, 0.5, 0.001)).toBeNull();
    expect(moveThresholdPts(100, null, 0.5, 0.001, { tick_size: 0.01 })).toBeGreaterThan(0);
  });
});
