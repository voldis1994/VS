import { describe, expect, it, beforeEach } from 'vitest';
import {
  decideEntryFrom10sRegime,
  decideExhaustionEntry,
  decideFailedBreakout,
  decideRangeRejection,
  decideReversalConfirm,
  denyWithTrendEntry,
  mergeTrendBias,
  trendBiasFromBars,
  trendBiasFromMinuteCandles,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { evaluateStrategy } from '../vs-core/strategyCore.js';
import { disableStrategyEvalLogForTests } from '../vs-core/strategyEvalLog.js';

function bar(open: number, close: number): TenSecBar {
  const high = Math.max(open, close) + 0.8;
  const low = Math.min(open, close) - 0.4;
  return { open_time_ms: 0, open, high, low, close, ticks: 12 };
}

const dip = bar(2000, 1996);
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

/** Flat-ish range then rejection at upper edge */
function rangeThenUpperReject(): { bars: TenSecBar[]; confirm: TenSecBar } {
  const bars: TenSecBar[] = [
    { open_time_ms: 1, open: 2000, high: 2002, low: 1998, close: 2000.5, ticks: 10 },
    { open_time_ms: 2, open: 2000.5, high: 2001.8, low: 1998.2, close: 1999.5, ticks: 10 },
    { open_time_ms: 3, open: 1999.5, high: 2002.0, low: 1998.5, close: 2001.2, ticks: 10 },
    { open_time_ms: 4, open: 2001.2, high: 2002.1, low: 1999.0, close: 2000.0, ticks: 10 },
  ];
  // Pierce near prior high then reject red
  const confirm: TenSecBar = {
    open_time_ms: 5,
    open: 2001.5,
    high: 2002.05,
    low: 1999.2,
    close: 1999.5,
    ticks: 12,
  };
  return { bars: [...bars, confirm], confirm };
}

describe('10s + regime-as-CONTEXT suitable entry', () => {
  beforeEach(() => disableStrategyEvalLogForTests(true));

  it('UNKNOWN / COMPRESSION never invent pullback from bias alone', () => {
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'COMPRESSION', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'UNKNOWN', 'DOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(rally, 'UNKNOWN', 'UP')).toBeNull();
  });

  it('TREND_UP dip-buy needs climb structure — lone dip is not enough', () => {
    expect(decideEntryFrom10sRegime(dip, 'TREND_UP', 'UP')).toBeNull();
    const climb = climbBars(9, 1990, 1.2);
    const pull = bar(climb[climb.length - 1]!.close, climb[climb.length - 1]!.close - 2);
    const hit = decideEntryFrom10sRegime(pull, 'TREND_UP', 'UP', [...climb, pull]);
    expect(hit?.direction).toBe('BUY');
    expect(hit?.setup).toBe('PULLBACK');
    expect(decideEntryFrom10sRegime(rally, 'TREND_UP', 'UP')).toBeNull();
  });

  it('COMPRESSION quiet Gold green does not chase BUY', () => {
    const quietGreen: TenSecBar = {
      open_time_ms: 0,
      open: 4374.9,
      high: 4375.05,
      low: 4374.9,
      close: 4375.0,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(quietGreen, 'COMPRESSION', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(quietGreen, 'COMPRESSION', 'DOWN')).toBeNull();
  });

  it('COMPRESSION + bias UP BUYs a doji — not SCAN', () => {
    const doji: TenSecBar = {
      open_time_ms: 0,
      open: 4338.12,
      high: 4338.12,
      low: 4337.7,
      close: 4338.12,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(doji, 'COMPRESSION', 'UP')).toBeNull();
  });

  it('TREND_DOWN structured dump SELLs — lone red without structure is null', () => {
    expect(decideEntryFrom10sRegime(dip, 'TREND_DOWN', 'DOWN')).toBeNull();
    const dump = dumpBars(9, 2010, 1.2);
    const last = dump[dump.length - 1]!;
    const more = bar(last.close, last.close - 2);
    expect(decideEntryFrom10sRegime(more, 'TREND_DOWN', 'DOWN', [...dump, more])?.direction).toBe(
      'SELL'
    );
    expect(decideEntryFrom10sRegime(rally, 'TREND_DOWN', 'DOWN')).toBeNull();
  });

  it('PULLBACK_UPTREND needs structure — soft dump alone is not enough', () => {
    expect(decideEntryFrom10sRegime(rally, 'PULLBACK_UPTREND', 'UP')).toBeNull();
    expect(decideEntryFrom10sRegime(dip, 'PULLBACK_UPTREND', 'UP')).toBeNull();
    const climb = climbBars(9, 1990, 1.2);
    const pull = bar(climb[climb.length - 1]!.close, climb[climb.length - 1]!.close - 2);
    expect(decideEntryFrom10sRegime(pull, 'PULLBACK_UPTREND', 'UP', [...climb, pull])?.direction).toBe(
      'BUY'
    );
  });

  it('BREAKOUT_UP follows up, not the failed red bar', () => {
    expect(decideEntryFrom10sRegime(rally, 'BREAKOUT_UP', 'UP')?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(dip, 'BREAKOUT_UP', 'UP')).toBeNull();
  });

  it('RANGE / FAILED_BREAKOUT / REVERSAL without evidence → null (not forbidden)', () => {
    const quiet: TenSecBar = {
      open_time_ms: 0,
      open: 2000,
      high: 2000.02,
      low: 1999.99,
      close: 2000.01,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(quiet, 'RANGE')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'FAILED_BREAKOUT_UP')).toBeNull();
    expect(decideEntryFrom10sRegime(quiet, 'REVERSAL_CANDIDATE')).toBeNull();
  });

  it('RANGE with upper-edge rejection evidence → RANGE_REJECTION SELL', () => {
    const { bars, confirm } = rangeThenUpperReject();
    const hit = decideRangeRejection(confirm, bars);
    expect(hit?.setup).toBe('RANGE_REJECTION');
    expect(hit?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(confirm, 'RANGE', 'FLAT', bars)?.setup).toBe('RANGE_REJECTION');
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

  it('Gold-sized dump needs down-structure history', () => {
    const goldDump: TenSecBar = {
      open_time_ms: 0,
      open: 4383.98,
      high: 4383.98,
      low: 4383.65,
      close: 4383.65,
      ticks: 12,
    };
    expect(decideEntryFrom10sRegime(goldDump, 'TREND_DOWN', 'DOWN')).toBeNull();
    expect(decideEntryFrom10sRegime(goldDump, 'UNKNOWN', 'FLAT')).toBeNull();
    expect(decideEntryFrom10sRegime(goldDump, 'UNKNOWN', 'DOWN')).toBeNull();
    const dump = dumpBars(8, 4390, 0.8);
    expect(
      decideEntryFrom10sRegime(goldDump, 'TREND_DOWN', 'DOWN', [...dump, goldDump])?.direction
    ).toBe('SELL');
  });

  it('EXPANSION + bias UP + dump needs up-structure (not soft pullback)', () => {
    const goldDump: TenSecBar = {
      open_time_ms: 0,
      open: 4346.42,
      high: 4346.42,
      low: 4345.25,
      close: 4345.25,
      ticks: 12,
    };
    const recent = [...climbBars(8, 4330, 2), goldDump];
    const hit = decideEntryFrom10sRegime(goldDump, 'EXPANSION', 'UP', recent);
    expect(hit?.direction).toBe('BUY');
    expect(hit?.setup).toBe('PULLBACK');
  });

  it('EXPANSION + bias DOWN needs down-structure', () => {
    const dump = dumpBars(8, 2010, 1.2);
    const last = dump[dump.length - 1]!;
    const more = bar(last.close, last.close - 2);
    expect(decideEntryFrom10sRegime(more, 'EXPANSION', 'DOWN', [...dump, more])?.direction).toBe(
      'SELL'
    );
    expect(decideEntryFrom10sRegime(rally, 'EXPANSION', 'DOWN')).toBeNull();
  });

  it('FAILED_BREAKOUT without confirmed fade → null (no soft dip-buy)', () => {
    const goldDump: TenSecBar = {
      open_time_ms: 0,
      open: 4340.22,
      high: 4340.22,
      low: 4339.03,
      close: 4339.03,
      ticks: 12,
    };
    expect(decideEntryFrom10sRegime(goldDump, 'FAILED_BREAKOUT_UP', 'UP')).toBeNull();
  });
});

describe('with-trend bias — no SELL into a climb without confirmed countertrend setup', () => {
  it('reads lasting climb/dump', () => {
    expect(trendBiasFromBars(climbBars())).toBe('UP');
    expect(trendBiasFromBars(dumpBars())).toBe('DOWN');
  });

  it('1m climb over 3 minutes is UP', () => {
    const climb = Array.from({ length: 3 }, (_, i) => ({
      open: 2000 + i * 1.2,
      close: 2000 + i * 1.2 + 0.8,
    }));
    expect(trendBiasFromMinuteCandles(climb)).toBe('UP');
  });

  it('lasting 1m trend wins over a short 10s pullback', () => {
    expect(mergeTrendBias('DOWN', 'UP')).toBe('UP');
    expect(mergeTrendBias('UP', 'DOWN')).toBe('DOWN');
  });

  it('never SELLs a green 10s bar on with-trend families', () => {
    const regimes = [
      'TREND_UP',
      'TREND_DOWN',
      'PULLBACK_UPTREND',
      'PULLBACK_DOWNTREND',
      'BREAKOUT_UP',
      'BREAKOUT_DOWN',
      'EXPANSION',
    ] as const;
    for (const r of regimes) {
      for (const bias of ['UP', 'DOWN', 'FLAT'] as const) {
        const hit = decideEntryFrom10sRegime(rally, r, bias);
        expect(hit?.direction, `${r} bias ${bias}`).not.toBe('SELL');
      }
    }
  });
});

describe('exhaustion FADE confirmation', () => {
  it('does not sell the large green impulse bar itself', () => {
    const impulse = bar(2000, 2004);
    const climb = [...climbBars(8, 1996, 0.3), impulse];
    expect(decideExhaustionEntry(climb)).toBeNull();
  });

  it('sells only after a red 10s that closes below the impulse close', () => {
    const impulse = bar(2000, 2004);
    const confirm = bar(2004, 2001.5);
    const bars = [...climbBars(6, 1996, 0.4), impulse, confirm];
    const hit = decideExhaustionEntry(bars);
    expect(hit?.direction).toBe('SELL');
    expect(hit?.setup).toBe('FADE');
    expect(hit?.exhaustion).toBe(true);
    expect(decideEntryFrom10sRegime(confirm, 'RANGE', 'UP', bars)?.direction).toBe('SELL');
  });

  it('buys only after a green 10s that closes above the dump close', () => {
    const impulse = bar(2000, 1996);
    const confirm = bar(1996, 1998.5);
    const bars = [...dumpBars(6, 2004, 0.4), impulse, confirm];
    expect(decideExhaustionEntry(bars)?.direction).toBe('BUY');
  });
});

describe('FAILED_BREAKOUT / REVERSAL confirmation helpers', () => {
  it('FAILED_BREAKOUT_UP without rejection → null', () => {
    const bars = climbBars(6);
    expect(decideFailedBreakout(rally, 'FAILED_BREAKOUT_UP', bars)).toBeNull();
  });

  it('FAILED_BREAKOUT_UP with red return into range → SELL', () => {
    const prior: TenSecBar[] = [
      { open_time_ms: 1, open: 2000, high: 2002, low: 1998, close: 2000, ticks: 8 },
      { open_time_ms: 2, open: 2000, high: 2001.5, low: 1998.5, close: 2001, ticks: 8 },
      { open_time_ms: 3, open: 2001, high: 2002, low: 1999, close: 2000.5, ticks: 8 },
    ];
    const confirm: TenSecBar = {
      open_time_ms: 4,
      open: 2001.8,
      high: 2002.2,
      low: 1999.5,
      close: 1999.8,
      ticks: 12,
    };
    const hit = decideFailedBreakout(confirm, 'FAILED_BREAKOUT_UP', [...prior, confirm]);
    expect(hit?.direction).toBe('SELL');
    expect(hit?.setup).toBe('FAILED_BREAKOUT');
  });

  it('REVERSAL without prior directional evidence → null', () => {
    expect(decideReversalConfirm(dip, [bar(2000, 2000.1), dip])).toBeNull();
  });
});

describe('evaluateStrategy FADE survives denyWithTrendEntry', () => {
  beforeEach(() => disableStrategyEvalLogForTests(true));

  it('EXHAUSTION + valid FADE confirmation → ENTER_SHORT even when bias UP', () => {
    const impulse = bar(2000, 2004);
    const confirm = bar(2004, 2001.5);
    const bars = [...climbBars(6, 1996, 0.4), impulse, confirm];
    const d = evaluateStrategy({
      epic: 'GOLD',
      market_snapshot_id: 'fade1',
      market_open: true,
      feed_fresh: true,
      bar_closed: true,
      closed_bar: confirm,
      bars,
      regime: 'RANGE',
      trading_enabled: true,
    });
    expect(d.code).toBe('ENTER_SHORT');
    expect(d.setup_type).toBe('FADE');
    expect(d.evidence.exhaustion).toBe(true);
  });
});
