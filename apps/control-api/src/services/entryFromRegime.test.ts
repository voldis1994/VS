import { describe, expect, it } from 'vitest';
import {
  decideEntryFrom10sRegime,
  decideExhaustionEntry,
  mergeTrendBias,
  trendBiasFromBars,
  trendBiasFromMinuteCandles,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number): TenSecBar {
  const high = Math.max(open, close) + 0.8;
  const low = Math.min(open, close) - 0.4;
  return { open_time_ms: 0, open, high, low, close, ticks: 12 };
}

const dip = bar(2000, 1996); // ~0.2% down — moving
const rally = bar(2000, 2004);

function climbBars(n = 12, start = 2000, step = 0.4): TenSecBar[] {
  const out: TenSecBar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const next = px + step;
    out.push(bar(px, next));
    px = next;
  }
  return out;
}

function dumpBars(n = 12, start = 2000, step = 0.4): TenSecBar[] {
  const out: TenSecBar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const next = px - step;
    out.push(bar(px, next));
    px = next;
  }
  return out;
}

describe('10s + 14-regime suitable entry', () => {
  it('UNKNOWN unlocks with bias OR bar-implied direction (no hard UNKNOWN block)', () => {
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN', 'UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'COMPRESSION', 'UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN', 'DOWN')?.direction).toBe('SELL');
    // FLAT + red bar → implied DOWN → follow dump
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN', 'FLAT')?.direction).toBe('SELL');
    // FLAT + green bar → implied UP → follow
    expect(decideEntryFrom10sRegime(rally, 'UNKNOWN', 'FLAT')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(rally, 'UNKNOWN', 'UP')?.direction).toBe('BUY');
  });

  it('TREND_UP dip-buys even when bias calculator is still FLAT (regime carries UP)', () => {
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP', 'UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP', 'UP')?.setup).toBe('PULLBACK');
    expect(decideEntryFrom10sRegime(rally, 'TREND_UP', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP', 'FLAT')?.direction).toBe('BUY');
  });

  it('TREND_DOWN follows the dump (red) — never sells a green breakout', () => {
    expect(decideEntryFrom10sRegime(dip, 'TREND_DOWN', 'DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(dip, 'TREND_DOWN', 'FLAT')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(rally, 'TREND_DOWN', 'DOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'TREND_DOWN')).toBeNull();
  });

  it('PULLBACK_UPTREND resumes long on the turn-up bar', () => {
    expect(decideEntryFrom10sRegime(rally, 'PULLBACK_UPTREND', 'UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(rally, 'PULLBACK_UPTREND', 'UP')?.setup).toBe('CONTINUATION');
    expect(decideEntryFrom10sRegime(dip, 'PULLBACK_UPTREND', 'UP')).toBeNull();
  });

  it('BREAKOUT_UP follows up, not the failed red bar', () => {
    expect(decideEntryFrom10sRegime(rally, 'BREAKOUT_UP', 'UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'BREAKOUT_UP', 'UP')).toBeNull();
  });

  it('FAILED_BREAKOUT / RANGE / REVERSAL never enter — those were the SELL SCALP / BUY LONG fades', () => {
    expect(decideEntryFrom10sRegime(dip, 'FAILED_BREAKOUT_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'FAILED_BREAKOUT_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'RANGE', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'RANGE', 'DOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'REVERSAL_CANDIDATE')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'REVERSAL_CANDIDATE')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'FAILED_BREAKOUT_DOWN')).toBeNull();
  });

  it('truly flat micro-noise bar is never a trade', () => {
    const quiet: TenSecBar = {
      open_time_ms: 0,
      open: 2000,
      high: 2000.02,
      low: 1999.99,
      close: 2000.01,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(quiet, 'TREND_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'BREAKOUT_UP')).toBeNull();
  });

  it('Gold-sized 0.33pt dump is a tradeable dip (was QUIET forever at old thresholds)', () => {
    const goldDump: TenSecBar = {
      open_time_ms: 0,
      open: 4383.98,
      high: 4383.98,
      low: 4383.65,
      close: 4383.65,
      ticks: 12,
    };
    expect(decideEntryFrom10sRegime(goldDump, 'TREND_DOWN', 'DOWN')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(goldDump, 'TREND_DOWN', 'FLAT')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(goldDump, 'UNKNOWN', 'FLAT')?.direction).toBe('SELL');
  });
});

describe('with-trend bias — no SELL SCALP into a climb, no BUY LONG into a dump', () => {
  it('reads a lasting 10s climb as UP and a dump as DOWN', () => {
    expect(trendBiasFromBars(climbBars())).toBe('UP');
    expect(trendBiasFromBars(dumpBars())).toBe('DOWN');
    expect(trendBiasFromBars([bar(2000, 2000.1), bar(2000.1, 2000.05)])).toBe('FLAT');
  });

  it('1m climb over 3 minutes is UP', () => {
    const climb = Array.from({ length: 3 }, (_, i) => ({
      open: 2000 + i * 1.2,
      close: 2000 + i * 1.2 + 0.8,
    }));
    expect(trendBiasFromMinuteCandles(climb)).toBe('UP');
    const dump = Array.from({ length: 3 }, (_, i) => ({
      open: 2000 - i * 1.2,
      close: 2000 - i * 1.2 - 0.8,
    }));
    expect(trendBiasFromMinuteCandles(dump)).toBe('DOWN');
  });

  it('ignores a 20-minute dump if the last 3 minutes climbed', () => {
    const oldDump = Array.from({ length: 17 }, (_, i) => ({
      open: 2100 - i * 2,
      close: 2100 - i * 2 - 1.5,
    }));
    const last3Up = [
      { open: 2060, close: 2062 },
      { open: 2062, close: 2064 },
      { open: 2064, close: 2067 },
    ];
    expect(trendBiasFromMinuteCandles([...oldDump, ...last3Up])).toBe('UP');
  });

  it('lasting 1m trend wins over a short 10s pullback', () => {
    expect(mergeTrendBias('DOWN', 'UP')).toBe('UP');
    expect(mergeTrendBias('UP', 'DOWN')).toBe('DOWN');
    expect(mergeTrendBias('UP', 'FLAT')).toBe('UP');
    expect(mergeTrendBias('FLAT', 'DOWN')).toBe('DOWN');
  });

  it('RANGE rally is not SELL SCALP while the market is climbing', () => {
    expect(decideEntryFrom10sRegime(rally, 'RANGE', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'RANGE', 'UP')).toBeNull();
  });

  it('RANGE dip is not BUY LONG while the market is dumping', () => {
    expect(decideEntryFrom10sRegime(dip, 'RANGE', 'DOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'RANGE', 'DOWN')).toBeNull();
  });

  it('FAILED_BREAKOUT / REVERSAL cannot sell a climb or buy a dump', () => {
    expect(decideEntryFrom10sRegime(dip, 'FAILED_BREAKOUT_UP', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'FAILED_BREAKOUT_DOWN', 'DOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'REVERSAL_CANDIDATE', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'REVERSAL_CANDIDATE', 'DOWN')).toBeNull();
  });

  it('never SELLs a green 10s bar — that was the circled sell into the gold climb', () => {
    const regimes = [
      'TREND_UP',
      'TREND_DOWN',
      'PULLBACK_UPTREND',
      'PULLBACK_DOWNTREND',
      'BREAKOUT_UP',
      'BREAKOUT_DOWN',
      'EXPANSION',
      'RANGE',
      'FAILED_BREAKOUT_UP',
      'REVERSAL_CANDIDATE',
    ];
    for (const r of regimes) {
      for (const bias of ['UP', 'DOWN', 'FLAT'] as const) {
        const hit = decideEntryFrom10sRegime(rally, r, bias);
        expect(hit?.direction, `${r} bias ${bias}`).not.toBe('SELL');
      }
    }
  });
});

describe('exhaustion SELL/BUY after a large move needs confirmation', () => {
  it('does not sell the large green impulse bar itself', () => {
    const impulse = bar(2000, 2004); // 0.20% up
    const climb = [...climbBars(8, 1996, 0.3), impulse];
    expect(decideExhaustionEntry(climb)).toBeNull();
    expect(decideEntryFrom10sRegime(impulse, 'RANGE', 'UP', climb)?.direction).not.toBe('SELL');
  });

  it('sells only after a red 10s that closes below the impulse close', () => {
    const impulse = bar(2000, 2004);
    const confirm = bar(2004, 2001.5);
    const bars = [...climbBars(6, 1996, 0.4), impulse, confirm];
    const hit = decideExhaustionEntry(bars);
    expect(hit?.direction).toBe('SELL');
    expect(hit?.setup).toBe('FADE');
    expect(decideEntryFrom10sRegime(confirm, 'RANGE', 'UP', bars)?.direction).toBe('SELL');
  });

  it('does not sell a tiny red twitch without a large prior move', () => {
    const bars = [bar(2000, 2000.2), bar(2000.2, 2000.35), bar(2000.35, 2000.2)];
    expect(decideExhaustionEntry(bars)).toBeNull();
  });

  it('buys only after a green 10s that closes above the dump close', () => {
    const impulse = bar(2000, 1996);
    const confirm = bar(1996, 1998.5);
    const bars = [...dumpBars(6, 2004, 0.4), impulse, confirm];
    expect(decideExhaustionEntry(bars)?.direction).toBe('BUY');
  });
});
