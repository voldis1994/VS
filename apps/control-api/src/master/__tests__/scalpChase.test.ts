import { describe, expect, it } from 'vitest';
import {
  evaluateCandleBiasFive,
  scalpStrictEntryAllowed,
} from '../candleBias.js';
import {
  SCALP_INITIAL_SL_PCT,
  SCALP_LOCK_PCT,
  scalpInitialStopDistance,
  scalpPctLockBrokerStop,
  scalpPctLockCandidateSl,
} from '../scalpPctChase.js';
import { EMPTY_BROKER_GHOST_DEBOUNCE, safetyStopLevel } from '../positionSync.js';

describe('VS-System scalp pct chase math', () => {
  it('exports 10% initial / 20% lock', () => {
    expect(SCALP_INITIAL_SL_PCT).toBe(0.1);
    expect(SCALP_LOCK_PCT).toBe(0.2);
    expect(scalpInitialStopDistance(4400)).toBe(440);
  });

  it('candidate SL trails mark by 20% of favorable move', () => {
    const entry = 4400;
    const mark = 4440;
    const cand = scalpPctLockCandidateSl({
      direction: 'BUY',
      entry,
      livePrice: mark,
      lockPct: 0.2,
    });
    expect(cand).toBeCloseTo(4432, 8);
  });

  it('flat/loss returns initial 10% protective broker stop', () => {
    const sl = scalpPctLockBrokerStop({
      symbol: 'GOLD',
      direction: 'BUY',
      entry: 4400,
      livePrice: 4395,
    });
    expect(sl).toBeCloseTo(4400 - 440, 1);
  });

  it('improve-only: pullback does not loosen candidate vs peak move', () => {
    const peak = scalpPctLockCandidateSl({
      direction: 'BUY',
      entry: 4400,
      livePrice: 4450,
    });
    const weaker = scalpPctLockCandidateSl({
      direction: 'BUY',
      entry: 4400,
      livePrice: 4420,
    });
    expect(peak).toBeGreaterThan(weaker);
  });

  it('safetyStopLevel uses 10% of entry', () => {
    expect(safetyStopLevel('BUY', 4400)).toBeCloseTo(3960, 5);
    expect(EMPTY_BROKER_GHOST_DEBOUNCE).toBe(5);
  });
});

describe('candle bias strict entry', () => {
  function bar(open: number, close: number) {
    return { open, high: Math.max(open, close), low: Math.min(open, close), close };
  }

  it('bearish majority → bias bear', () => {
    const candles = [
      bar(104, 103),
      bar(103, 102),
      bar(102, 101),
      bar(101, 101.5),
      bar(101.5, 100.8),
    ];
    expect(evaluateCandleBiasFive(candles, { includeForming: true }).bias).toBe('bear');
  });

  it('blocks BUY without bull TF', () => {
    expect(
      scalpStrictEntryAllowed({
        signal: 'BUY',
        tfBias: 'bear',
        tfNetPct: -0.1,
        microBias: 'flat',
        buyScore: 0.8,
        sellScore: 0.4,
      }).ok
    ).toBe(false);
  });

  it('allows BUY with bull TF + edge', () => {
    expect(
      scalpStrictEntryAllowed({
        signal: 'BUY',
        tfBias: 'bull',
        tfNetPct: 0.05,
        microBias: 'bull',
        buyScore: 0.8,
        sellScore: 0.4,
        minEdge: 0.12,
      }).ok
    ).toBe(true);
  });
});
