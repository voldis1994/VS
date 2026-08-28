/**
 * Regression invariants for follow-up fixes #1–#5:
 * 1. Single noteRiskTradeOpen after fill + Safety SL
 * 2. Broker-confirmed realized PnL only → riskWindow
 * 3. marketStructure explicit provenance === 'REAL'
 * 4. Universal session-aware gap classification
 * 5. BO continuation holds past 1R toward structure_target
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  decideBestOutcomeExit,
  boMfeFloor,
  boTpDistance,
  boSlDistance,
  type ExitSnapshot,
} from './exitManage.js';
import { analyzeMarketStructure } from './marketStructure.js';
import { isRealBar, isSyntheticBar } from './ohlcQuality.js';
import {
  noteRiskTradeOpen,
  noteRiskTradePnl,
  getRiskSnapshot,
  resetRiskWindows,
  setRiskEquity,
} from './riskWindow.js';
import { classifyBarGap, TF_MS, evaluateTfBook } from './timeframeBooks.js';
import type { TfBar } from './timeframeBooks.js';
import { parseCapitalOpeningHours, classifyBarGapWithOpeningHours } from './tradingSessions.js';

const GOLD_META = { tick_size: 0.01 };
const here = dirname(fileURLToPath(import.meta.url));

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date(Date.now() - 6 * 60_000).toISOString(),
    regime: 'TREND_UP',
    tick_size: GOLD_META.tick_size,
    ...partial,
  };
}

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  provenance?: 'REAL' | 'SYNTHETIC'
): Parameters<typeof analyzeMarketStructure>[0][number] {
  return {
    open_time_ms: t,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks: 10,
    ...(provenance != null ? { provenance } : {}),
  };
}

describe('#1 single noteRiskTradeOpen — risk counter', () => {
  beforeEach(() => resetRiskWindows());

  it('one open notes exactly 1 trade in the window', () => {
    setRiskEquity(42, 10_000, Date.now());
    noteRiskTradeOpen(42, Date.now());
    const snap1 = getRiskSnapshot(42, 0, Date.now());
    expect(snap1.trades_in_window).toBe(1);
    // Second call would double-count at riskWindow level — robotDesk guards with risk_open_noted
    noteRiskTradeOpen(42, Date.now());
    expect(getRiskSnapshot(42, 0, Date.now()).trades_in_window).toBe(2);
  });

  it('robotDesk activates risk clock only after fill + Safety SL (source contract)', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    // Exactly one noteRiskTradeOpen call site in LIVE desk
    const opens = src.match(/noteRiskTradeOpen\(/g) ?? [];
    expect(opens.length).toBe(1);
    // Guarded by risk_open_noted and placed after ensureCapitalStopVisible success path
    expect(src).toMatch(/risk_open_noted/);
    expect(src).toMatch(/Risk clock \/ trade counter — exactly once after broker fill AND Safety SL/);
    // Must not note on fill alone
    expect(src).toMatch(/Risk clock NOT here — wait until Safety SL visible/);
    // Manual lot size remains authoritative
    expect(src).toMatch(/size:\s*s\.lot_size/);
    expect(src).not.toMatch(/computeRiskPositionSize\(/);
  });
});

describe('#2 broker-confirmed realized PnL → riskWindow', () => {
  beforeEach(() => resetRiskWindows());

  it('notes only finite realized PnL; never invents from unknown', () => {
    setRiskEquity(7, 5_000, Date.now());
    noteRiskTradeOpen(7, Date.now());
    noteRiskTradePnl(7, 12.5, Date.now());
    expect(getRiskSnapshot(7, 0, Date.now()).realized_pnl).toBeCloseTo(12.5, 5);
  });

  it('noteRiskTradePnl rejects non-finite — risk state must not invent', () => {
    setRiskEquity(8, 5_000, Date.now());
    noteRiskTradeOpen(8, Date.now());
    noteRiskTradePnl(8, Number.NaN, Date.now());
    noteRiskTradePnl(8, Number.POSITIVE_INFINITY, Date.now());
    expect(getRiskSnapshot(8, 0, Date.now()).realized_pnl).toBe(0);
  });

  it('exitTrade uses fetchCapitalConfirmedProfit and skips inventing UPL (source contract)', () => {
    const desk = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(desk).toMatch(/fetchCapitalConfirmedProfit/);
    expect(desk).toMatch(/RISK PnL UNKNOWN · skipped noteRiskTradePnl/);
    expect(desk).toMatch(/Broker-confirmed realized only/);
    const capital = readFileSync(join(here, 'capitalCom.ts'), 'utf8');
    expect(capital).toMatch(/profitAndLoss/);
    expect(capital).toMatch(/realizedProfit/);
    expect(capital).toMatch(/fetchCapitalConfirmedProfit/);
  });
});

describe('#3 marketStructure provenance === REAL only', () => {
  it('isRealBar requires explicit REAL — missing is not synthetic and not real', () => {
    expect(isRealBar({ provenance: 'REAL' })).toBe(true);
    expect(isRealBar({ provenance: 'SYNTHETIC' })).toBe(false);
    expect(isRealBar({})).toBe(false);
    expect(isRealBar(undefined)).toBe(false);
    expect(isSyntheticBar({})).toBe(false);
    expect(isSyntheticBar({ provenance: 'SYNTHETIC' })).toBe(true);
  });

  it('bars without provenance are excluded (UNKNOWN = BLOCK) — !isSynthetic is insufficient', () => {
    const t0 = 1_700_000_000_000;
    const step = 5 * 60_000;
    // Build a clear swing series — all missing provenance
    const unknown = Array.from({ length: 20 }, (_, i) => {
      const base = 100 + (i % 4 === 0 ? 2 : i % 4 === 2 ? -2 : 0);
      return bar(t0 + i * step, base, base + 1.5, base - 1.5, base + 0.2);
    });
    const msUnknown = analyzeMarketStructure(unknown, { pivotLeft: 1, pivotRight: 1 });
    expect(msUnknown.pivots.length).toBe(0);

    // Same series with explicit REAL → structure can form
    const real = unknown.map((b) => ({ ...b, provenance: 'REAL' as const }));
    const msReal = analyzeMarketStructure(real, { pivotLeft: 1, pivotRight: 1 });
    expect(msReal.pivots.length).toBeGreaterThan(0);

    // SYNTHETIC alone must not drive structure
    const syn = unknown.map((b) => ({ ...b, provenance: 'SYNTHETIC' as const }));
    const msSyn = analyzeMarketStructure(syn, { pivotLeft: 1, pivotRight: 1 });
    expect(msSyn.pivots.length).toBe(0);
  });

  it('marketStructure source uses isRealBar, not !isSyntheticBar', () => {
    const src = readFileSync(join(here, 'marketStructure.ts'), 'utf8');
    expect(src).toMatch(/isRealBar\(b\)/);
    expect(src).not.toMatch(/!isSyntheticBar/);
  });
});

describe('#4 Capital openingHours gap classification (no epic guess)', () => {
  it('without Capital hours: excess gap is UNKNOWN (NOT_READY)', () => {
    const step = TF_MS['1H'];
    expect(classifyBarGap(0, step, step)).toBe('none');
    expect(classifyBarGap(0, 60 * 3_600_000, step)).toBe('unknown');
    expect(classifyBarGap(0, 10 * 3_600_000, step)).toBe('unknown');
    expect(classifyBarGapWithOpeningHours(0, 60 * 3_600_000, step, null)).toBe('unknown');
  });

  it('Capital 24/7 hours: excess gap is missing — never session from length', () => {
    const slot = [{ openTime: '00:00', closeTime: '23:59:59' }];
    const crypto = parseCapitalOpeningHours(
      {
        sunday: slot,
        monday: slot,
        tuesday: slot,
        wednesday: slot,
        thursday: slot,
        friday: slot,
        saturday: slot,
      },
      { timezone: 'UTC' }
    )!;
    expect(crypto.continuously_open).toBe(true);
    expect(
      classifyBarGapWithOpeningHours(0, 60 * 3_600_000, TF_MS['1H'], crypto)
    ).toBe('missing');
  });

  it('Capital weekday hours: weekend closed gap can be session', () => {
    const slot = [{ openTime: '07:00', closeTime: '21:00' }];
    const fx = parseCapitalOpeningHours(
      {
        monday: slot,
        tuesday: slot,
        wednesday: slot,
        thursday: slot,
        friday: slot,
      },
      { timezone: 'UTC' }
    )!;
    const fri20 = Date.UTC(2024, 0, 5, 20, 0, 0);
    const mon07 = Date.UTC(2024, 0, 8, 7, 0, 0);
    expect(
      classifyBarGapWithOpeningHours(fri20, mon07, TF_MS['1H'], fx)
    ).toBe('session');
  });

  it('evaluateTfBook: unknown gaps → NOT_READY', () => {
    const step = TF_MS['1H'];
    const t0 = 1_700_000_000_000;
    const bars: TfBar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push({
        open_time_ms: t0 + i * step,
        open: 100 + i * 0.01,
        high: 101 + i * 0.01,
        low: 99 + i * 0.01,
        close: 100.5 + i * 0.01,
        ticks: 5,
        provenance: 'REAL',
        source_tf: '1H',
      });
    }
    // Insert a large unexplained gap in the middle, then continue regularly
    bars[10]!.open_time_ms = bars[9]!.open_time_ms + 60 * 3_600_000;
    for (let i = 11; i < bars.length; i++) {
      bars[i]!.open_time_ms = bars[i - 1]!.open_time_ms + step;
    }
    const lastOpen = bars[bars.length - 1]!.open_time_ms;
    const now = lastOpen + step * 2; // all bars closed
    const book = evaluateTfBook('1H', bars, 'CAPITAL_NATIVE', now, null);
    expect(book.ready).toBe(false);
    expect(book.detail).toMatch(/unknown gaps/i);
  });
});

describe('#5 BO Aug 13 setup', () => {
  it('boMfeFloor scales with entry (~0.12%)', () => {
    const entry = 4640;
    expect(boMfeFloor(entry)).toBeCloseTo(Math.max(entry * 0.0012, 0.12), 4);
  });

  it('holds below mfeFloor even on deep retention giveback', () => {
    const entry = 4640;
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 0.86,
        peak_retention: 0.05,
        regime: 'TREND_UP',
      }),
      entry + 0.01
    );
    expect(hold.exit).toBe(false);
  });

  it('PeakProtection after meaningful MFE and ret < 30%', () => {
    const entry = 4640;
    const mfe = 8;
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        peak_retention: 0.25,
        regime: 'TREND_UP',
      }),
      entry + 2
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
  });

  it('HardInv still exits on full SL', () => {
    const entry = 4600;
    const sl = boSlDistance(entry);
    const hi = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 10,
        peak_retention: 0.9,
        regime: 'TREND_UP',
      }),
      entry - sl - 0.01
    );
    expect(hi.exit).toBe(true);
    expect(hi.reason).toMatch(/HardInvalidation/);
  });

  it('target exit at ~0.35% TP', () => {
    const entry = 4640;
    const tp = boTpDistance(entry);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: tp,
        peak_retention: 1,
        regime: 'TREND_UP',
      }),
      entry + tp
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/Target/);
  });
});

describe('#5 robotDesk BO wiring', () => {
  it('robotDesk uses Aug-13 mid-price BO snapshot', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/decideBestOutcomeExit\([\s\S]*quote\.mid/);
    expect(src).toMatch(/deskConflictShouldExit/);
  });
});
