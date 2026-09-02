import { describe, expect, it } from 'vitest';
import {
  playbookFromRegime,
  thesisFailureForPlaybook,
  nearRangeEdge,
  PLAYBOOK_EXIT,
} from './playbooks.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { decideBestOutcomeExit, THESIS_MIN_HOLD_MS } from './exitManage.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0): TenSecBar {
  const high = Math.max(open, close) + Math.abs(open) * 0.001;
  const low = Math.min(open, close) - Math.abs(open) * 0.001;
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 12 };
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('playbookFromRegime', () => {
  it('maps families as drawn', () => {
    expect(playbookFromRegime('TREND_UP')).toBe('LONG');
    expect(playbookFromRegime('PULLBACK_DOWNTREND')).toBe('LONG');
    expect(playbookFromRegime('BREAKOUT_UP')).toBe('SCALP');
    expect(playbookFromRegime('EXPANSION')).toBe('SCALP');
    expect(playbookFromRegime('RANGE')).toBe('FADE');
    expect(playbookFromRegime('FAILED_BREAKOUT_UP')).toBe('FADE');
    expect(playbookFromRegime('FAILED_BREAKOUT_DOWN')).toBe('FADE');
    expect(playbookFromRegime('COMPRESSION')).toBe('WAIT');
    expect(playbookFromRegime('UNKNOWN')).toBe('FADE'); // collapsed → RANGE
    expect(playbookFromRegime('TRANSITION')).toBe('FADE');
  });
});

describe('playbook entry', () => {
  const longDip = bar(2000, 1998.8); // 0.06% down — LONG body
  const longRally = bar(2000, 2001.2);
  const microDip = bar(2000, 1999.95); // 0.0025% — below LONG body
  const scalpRally = bar(2000, 2000.8); // 0.04%
  const fadeDip = bar(2000, 1999.4); // 0.03%

  it('WAIT only on COMPRESSION — UNKNOWN/TRANSITION collapse to RANGE FADE', () => {
    expect(decideEntryFrom10sRegime(longDip, 'COMPRESSION', { playbookAgeBars: 5 })).toBeNull();
    // UNKNOWN → RANGE → FADE needs zone/edge; without edge still null but not WAIT-book
    expect(
      decideEntryFrom10sRegime(longDip, 'UNKNOWN', { playbookAgeBars: 5 })
    ).toBeNull();
  });

  it('LONG needs family age ≥1 and strong dip', () => {
    expect(
      decideEntryFrom10sRegime(longDip, 'TREND_UP', { playbookAgeBars: 0, regimeAgeBars: 0 })
    ).toBeNull();
    const sig = decideEntryFrom10sRegime(longDip, 'TREND_UP', {
      playbookAgeBars: 1,
      regimeAgeBars: 1,
    });
    expect(sig?.playbook).toBe('LONG');
    expect(sig?.direction).toBe('BUY');
    expect(decideEntryFrom10sRegime(microDip, 'TREND_UP', { playbookAgeBars: 5 })).toBeNull();
  });

  it('LONG allows entry right after RANGE flip when body is strong', () => {
    const sig = decideEntryFrom10sRegime(longDip, 'TREND_UP', {
      playbookAgeBars: 5,
      regimeAgeBars: 1,
      previousRegime: 'RANGE',
    });
    expect(sig?.direction).toBe('BUY');
  });

  it('SCALP BREAKOUT needs age ≥1', () => {
    expect(
      decideEntryFrom10sRegime(scalpRally, 'BREAKOUT_UP', { playbookAgeBars: 0 })
    ).toBeNull();
    const sig = decideEntryFrom10sRegime(scalpRally, 'BREAKOUT_UP', { playbookAgeBars: 1 });
    expect(sig?.playbook).toBe('SCALP');
    expect(sig?.direction).toBe('BUY');
  });

  it('RANGE FADE only at edge, SELL on high edge', () => {
    const prior: TenSecBar[] = [
      { open_time_ms: 0, open: 2000, high: 2005, low: 1995, close: 2000, ticks: 10 },
      { open_time_ms: 10_000, open: 2000, high: 2004, low: 1996, close: 2001, ticks: 10 },
    ];
    const midDip = bar(2000, 1999.4); // dip but mid-range (~2000)
    expect(
      decideEntryFrom10sRegime(midDip, 'RANGE', {
        playbookAgeBars: 3,
        priorBars: prior,
      })
    ).toBeNull();

    const edgeLow = bar(1996.5, 1995.2); // near prior low 1995
    const buy = decideEntryFrom10sRegime(edgeLow, 'RANGE', {
      playbookAgeBars: 3,
      priorBars: prior,
    });
    expect(buy?.direction).toBe('BUY');
    expect(buy?.playbook).toBe('FADE');

    const edgeHigh = bar(2003.5, 2004.8);
    const sell = decideEntryFrom10sRegime(edgeHigh, 'RANGE', {
      playbookAgeBars: 3,
      priorBars: prior,
    });
    expect(sell?.direction).toBe('SELL');
  });

  it('FADE skips first bar after TREND', () => {
    expect(
      decideEntryFrom10sRegime(fadeDip, 'RANGE', {
        playbookAgeBars: 3,
        regimeAgeBars: 1,
        previousRegime: 'TREND_UP',
        priorBars: [
          { open_time_ms: 0, open: 2000, high: 2010, low: 1990, close: 2000, ticks: 10 },
        ],
      })
    ).toBeNull();
  });
});

describe('playbook exit', () => {
  it('LONG ignores PULLBACK_DOWNTREND thesis (hold through pullback)', () => {
    const d = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(130_000),
        mfe: 4,
        mae: 0,
        peak_retention: 0.8,
        regime: 'PULLBACK_DOWNTREND',
        playbook: 'LONG',
      },
      2002
    );
    expect(d.exit).toBe(false);
  });

  it('LONG thesis on TREND_DOWN after 120s', () => {
    const young = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(30_000),
        mfe: 2,
        mae: 0,
        peak_retention: 0.9,
        regime: 'TREND_DOWN',
        playbook: 'LONG',
      },
      2001
    );
    expect(young.exit).toBe(false);
    const aged = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(130_000),
        mfe: 2,
        mae: 0,
        peak_retention: 0.9,
        regime: 'TREND_DOWN',
        playbook: 'LONG',
      },
      2001
    );
    expect(aged.exit).toBe(true);
    expect(aged.reason).toMatch(/LONG/);
  });

  it('SCALP PeakProtect at ret < 55%, LONG at < 40%', () => {
    const scalp = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(60_000),
        mfe: 5,
        mae: 0,
        peak_retention: 0.5,
        regime: 'BREAKOUT_UP',
        playbook: 'SCALP',
      },
      2002.5
    );
    expect(scalp.exit).toBe(true);
    expect(scalp.reason).toMatch(/PeakProtection/);

    const longHold = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(60_000),
        mfe: 5,
        mae: 0,
        peak_retention: 0.6,
        regime: 'TREND_UP',
        playbook: 'LONG',
      },
      2003
    );
    expect(longHold.exit).toBe(false);
  });

  it('FADE TimeDecay at 4 min when non-negative', () => {
    const d = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(250_000),
        mfe: 2,
        mae: 0,
        peak_retention: 0.7,
        regime: 'RANGE',
        playbook: 'FADE',
      },
      2000.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/TimeDecay/);
  });

  it('exit params match the drawing', () => {
    expect(PLAYBOOK_EXIT.LONG.peakRet).toBe(0.4);
    expect(PLAYBOOK_EXIT.LONG.thesisMinHoldMs).toBe(120_000);
    expect(PLAYBOOK_EXIT.SCALP.tpPct).toBe(0.0022);
    expect(PLAYBOOK_EXIT.FADE.timeDecayMs).toBe(240_000);
  });
});

describe('nearRangeEdge', () => {
  it('detects low/high proximity', () => {
    const prior = [
      { open_time_ms: 0, open: 100, high: 110, low: 90, close: 100, ticks: 5 },
    ];
    expect(nearRangeEdge(bar(91, 90.5), prior, 'low')).toBe(true);
    expect(nearRangeEdge(bar(100, 99.5), prior, 'low')).toBe(false);
    expect(nearRangeEdge(bar(109, 109.5), prior, 'high')).toBe(true);
  });
});

describe('thesisFailureForPlaybook', () => {
  it('divides LONG vs SCALP lists', () => {
    expect(thesisFailureForPlaybook('BUY', 'PULLBACK_DOWNTREND', 'LONG')).toBeNull();
    expect(thesisFailureForPlaybook('BUY', 'PULLBACK_DOWNTREND', 'SCALP')).toMatch(/SCALP/);
    expect(thesisFailureForPlaybook('BUY', 'TREND_DOWN', 'FADE')).toMatch(/FADE/);
  });
});
