import { describe, expect, it } from 'vitest';
import {
  playbookFromRegime,
  thesisFailureForPlaybook,
  nearRangeEdge,
  exitParamsForTrade,
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
  it('maps families: trend/breakout=LONG, pullback/range=SCALP, failed=FADE', () => {
    expect(playbookFromRegime('TREND_UP')).toBe('LONG');
    expect(playbookFromRegime('PULLBACK_DOWNTREND')).toBe('SCALP');
    expect(playbookFromRegime('BREAKOUT_UP')).toBe('LONG');
    expect(playbookFromRegime('EXPANSION')).toBe('SCALP');
    expect(playbookFromRegime('RANGE')).toBe('SCALP');
    expect(playbookFromRegime('FAILED_BREAKOUT_UP')).toBe('FADE');
    expect(playbookFromRegime('FAILED_BREAKOUT_DOWN')).toBe('FADE');
    expect(playbookFromRegime('COMPRESSION')).toBe('WAIT');
    expect(playbookFromRegime('UNKNOWN')).toBe('SCALP'); // collapsed → RANGE → SCALP
    expect(playbookFromRegime('TRANSITION')).toBe('SCALP');
  });
});

describe('playbook entry', () => {
  const longDip = bar(2000, 1998.8); // 0.06% down — LONG body
  const longRally = bar(2000, 2001.2);
  const microDip = bar(2000, 1999.95); // 0.0025% — below LONG body
  const scalpRally = bar(2000, 2000.8); // 0.04%
  const fadeDip = bar(2000, 1999.4); // 0.03%

  it('WAIT only on COMPRESSION — UNKNOWN/TRANSITION collapse to RANGE SCALP', () => {
    expect(decideEntryFrom10sRegime(longDip, 'COMPRESSION', { playbookAgeBars: 5 })).toBeNull();
    // UNKNOWN → RANGE → SCALP needs zone/edge; without edge still null but not WAIT-book
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

  it('LONG BREAKOUT needs age ≥1', () => {
    expect(
      decideEntryFrom10sRegime(scalpRally, 'BREAKOUT_UP', { playbookAgeBars: 0 })
    ).toBeNull();
    const sig = decideEntryFrom10sRegime(scalpRally, 'BREAKOUT_UP', { playbookAgeBars: 1 });
    expect(sig?.playbook).toBe('LONG');
    expect(sig?.direction).toBe('BUY');
  });

  it('RANGE SCALP only at edge, SELL on high edge', () => {
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
    expect(buy?.playbook).toBe('SCALP');

    const edgeHigh = bar(2003.5, 2004.8);
    const sell = decideEntryFrom10sRegime(edgeHigh, 'RANGE', {
      playbookAgeBars: 3,
      priorBars: prior,
    });
    expect(sell?.direction).toBe('SELL');
    expect(sell?.playbook).toBe('SCALP');
  });

  it('SCALP skips first bar after TREND on RANGE', () => {
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
      2003.2 // still ≥75% of MFE — pullback thesis must not cut
    );
    expect(d.exit).toBe(false);
  });

  it('LONG thesis on TREND_DOWN after 120s only when UPL ≤ 0', () => {
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
      1999.5
    );
    expect(young.exit).toBe(false);
    const agedGreen = decideBestOutcomeExit(
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
      2001.6 // green ≥75% MFE — thesis must not cut; PeakProtect must not either
    );
    expect(agedGreen.exit).toBe(false);
    const agedRed = decideBestOutcomeExit(
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
      1999.5
    );
    expect(agedRed.exit).toBe(true);
    expect(agedRed.reason).toMatch(/LONG/);
  });

  it('all books PeakProtect by style — LONG 75%, SCALP 90%', () => {
    const scalp = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(60_000),
        mfe: 5,
        mae: 0,
        peak_retention: 0.5,
        regime: 'PULLBACK_UPTREND',
        playbook: 'SCALP',
        entry_setup: 'PULLBACK',
      },
      2002.5
    );
    expect(scalp.exit).toBe(true);
    expect(scalp.reason).toMatch(/PeakProtection/);

    const longCut = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(60_000),
        mfe: 5,
        mae: 0,
        peak_retention: 0.5,
        regime: 'TREND_UP',
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      },
      2002.5
    );
    expect(longCut.exit).toBe(true);
    expect(longCut.reason).toMatch(/PeakProtection/);

    const longHold = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(60_000),
        mfe: 5,
        mae: 0,
        peak_retention: 0.8,
        regime: 'TREND_UP',
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      },
      2004
    );
    expect(longHold.exit).toBe(false);

    // SCALP must cut earlier than LONG: 85% retention still exits (below 90%)
    // Keep fav below SCALP TP floor (3.5) so PeakProtect wins over Target
    const scalpTight = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(60_000),
        mfe: 3,
        mae: 0,
        peak_retention: 0.95,
        regime: 'PULLBACK_UPTREND',
        playbook: 'SCALP',
        entry_setup: 'PULLBACK',
      },
      2002.55 // fav 2.55 = 85% of MFE 3 — below TP 3.5, below 90% PeakProtect
    );
    expect(scalpTight.exit).toBe(true);
    expect(scalpTight.reason).toMatch(/PeakProtection/);
  });

  it('FADE TimeDecay at 3 min when non-negative', () => {
    const d = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(190_000),
        mfe: 0.5, // below PeakProtect floor → TimeDecay path
        mae: 0,
        peak_retention: 0.8,
        regime: 'RANGE',
        playbook: 'FADE',
      },
      2000.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/TimeDecay/);
  });

  it('exit params: LONG 75% / SCALP·FADE 90% PeakProtect', () => {
    expect(PLAYBOOK_EXIT.LONG.peakRet).toBe(0.75);
    expect(PLAYBOOK_EXIT.SCALP.peakRet).toBe(0.9);
    expect(PLAYBOOK_EXIT.FADE.peakRet).toBe(0.9);
    expect(PLAYBOOK_EXIT.LONG.thesisMinHoldMs).toBe(120_000);
    expect(PLAYBOOK_EXIT.SCALP.tpPct).toBe(0.0016);
    expect(PLAYBOOK_EXIT.FADE.timeDecayMs).toBe(180_000);
    expect(PLAYBOOK_EXIT.LONG.slCapAbs).toBe(2.5);
    expect(PLAYBOOK_EXIT.LONG.tpFloor).toBe(6.0);
    expect(PLAYBOOK_EXIT.SCALP.slCapAbs).toBe(2.0);
  });

  it('CONTINUATION setup uses LONG 75% retention + TP ≫ SL', () => {
    const p = exitParamsForTrade('LONG', 'CONTINUATION');
    expect(p.peakRet).toBe(0.75);
    expect(p.harvestRet).toBe(0.75);
    expect(p.tpFloor).toBe(6.5);
    expect(p.slCapAbs).toBe(2.5);
    expect(p.mfeFloorAbs).toBe(2.5);
  });

  it('PULLBACK SCALP uses 90% PeakProtect', () => {
    const p = exitParamsForTrade('SCALP', 'PULLBACK');
    expect(p.peakRet).toBe(0.9);
    expect(p.slCapAbs).toBe(2.0);
    expect(p.mfeFloorAbs).toBe(1.2);
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
