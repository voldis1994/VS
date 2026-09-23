import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { REGIME_NAMES, MIN_BARS_FOR_ZONE } from './regimes.js';
import {
  aggregateTenSecToMinutes,
  decideEntryWithStructure,
  lastClosed1mFromTenSec,
  structureGate,
  structureStartEntry,
  zoneGeometry,
} from './structureEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, t = 0, pad = 0.2): TenSecBar {
  return {
    open_time_ms: t,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad * 0.5,
    close,
    ticks: 10,
  };
}

/** Quiet ~15m+ zone with painted hi/lo; last bar = entry */
function zoneBook(opts: {
  lo: number;
  hi: number;
  lastClose: number;
  lastOpen?: number;
  baseMs?: number;
}): TenSecBar[] {
  const baseMs = opts.baseMs ?? Math.floor(Date.now() / 60_000) * 60_000 - 600_000;
  const mid = (opts.lo + opts.hi) / 2;
  const out: TenSecBar[] = [];
  for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
    out.push({
      open_time_ms: baseMs + i * 10_000,
      open: mid,
      high: i === 5 ? opts.hi : mid + 0.25,
      low: i === 15 ? opts.lo : mid - 0.25,
      close: mid + ((i % 3) - 1) * 0.04,
      ticks: 8,
    });
  }
  const lastOpen = opts.lastOpen ?? opts.lastClose;
  out.push(bar(lastOpen, opts.lastClose, baseMs + MIN_BARS_FOR_ZONE * 10_000, 0.25));
  return out;
}

describe('10s → 1m aggregate', () => {
  it('builds 6×10s into one minute candle', () => {
    const minute = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
    const bars: TenSecBar[] = [];
    for (let k = 0; k < 6; k++) {
      bars.push(bar(100 + k * 0.1, 100 + k * 0.1 + 0.05, minute + k * 10_000));
    }
    const mins = aggregateTenSecToMinutes(bars);
    expect(mins).toHaveLength(1);
    expect(mins[0]!.bars).toBe(6);
  });

  it('lastClosed1mFromTenSec accepts ≥3 bars in a closed minute', () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
    const bars = [0, 1, 2].map((k) => bar(2000, 2000.3, minute + k * 10_000));
    expect(lastClosed1mFromTenSec(bars)?.close).toBe(2000.3);
  });
});

describe('zone geometry uses entry close', () => {
  it('pos from entry bar, hi/lo from structure', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4322, lastOpen: 4323 });
    const entry = book[book.length - 1]!;
    const z = zoneGeometry(book, entry);
    expect(z).not.toBeNull();
    expect(z!.pos).toBeLessThan(0.5);
  });
});

describe('executable gates (not impossible AND-stacks)', () => {
  it('TREND_UP dip mid-zone still arms (pullbacks are not only at LO)', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4330, lastOpen: 4331.5 });
    const entry = book[book.length - 1]!;
    const raw = decideEntryFrom10sRegime(entry, 'TREND_UP');
    expect(raw?.direction).toBe('BUY');
    const gated = decideEntryWithStructure({
      bar: entry,
      regime: 'TREND_UP',
      closedBars: book,
    });
    expect(gated?.direction).toBe('BUY');
  });

  it('BREAKOUT_UP allows pierce even if prior 1m was red', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4341, lastOpen: 4339 });
    const entry = book[book.length - 1]!;
    const sig = {
      direction: 'BUY' as const,
      setup: 'BREAKOUT' as const,
      reason: 'BREAKOUT_UP follow',
    };
    const red1m = {
      open_time_ms: 0,
      open: 4335,
      high: 4336,
      low: 4328,
      close: 4329,
      bars: 6,
    };
    const gate = structureGate(sig, 'BREAKOUT_UP', entry, zoneGeometry(book, entry), red1m);
    expect(gate.ok).toBe(true);
  });

  it('RANGE fade BUY only lower half; mid rejected; LO allowed', () => {
    const midBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4332, lastOpen: 4333 });
    const fade = { direction: 'BUY' as const, setup: 'FADE' as const, reason: 'fade' };
    expect(
      structureGate(fade, 'RANGE', midBook[midBook.length - 1]!, zoneGeometry(midBook), null).ok
    ).toBe(false);

    const loBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4324, lastOpen: 4325.5 });
    expect(
      structureGate(fade, 'RANGE', loBook[loBook.length - 1]!, zoneGeometry(loBook), null).ok
    ).toBe(true);
  });

  it('FAILED_BREAKOUT_UP SELL allowed in upper half (not forced to LO)', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4336, lastOpen: 4337.5 });
    const sig = { direction: 'SELL' as const, setup: 'FADE' as const, reason: 'failed' };
    const gate = structureGate(sig, 'FAILED_BREAKOUT_UP', book[book.length - 1]!, zoneGeometry(book), null);
    expect(gate.ok).toBe(true);
  });

  it('structure-start BUY from LO-half with 1m flat/green + 10s rally', () => {
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      book.push({
        open_time_ms: m0 - MIN_BARS_FOR_ZONE * 10_000 + i * 10_000,
        open: 4330,
        high: i === 5 ? 4340 : 4330.3,
        low: i === 15 ? 4320 : 4329.7,
        close: 4330,
        ticks: 8,
      });
    }
    for (let k = 0; k < 6; k++) {
      book.push(bar(4322 + k * 0.1, 4322 + k * 0.1 + 0.05, m0 + k * 10_000));
    }
    const trigger = bar(4323.0, 4324.0, m0 + 60_000);
    book.push(trigger);
    const z = zoneGeometry(book, trigger);
    const m1 = { open_time_ms: m0, open: 4322, high: 4323, low: 4321.5, close: 4322.5, bars: 6 };
    expect(structureStartEntry(trigger, 'TREND_UP', z, m1)?.direction).toBe('BUY');
    expect(
      decideEntryWithStructure({ bar: trigger, regime: 'TREND_UP', closedBars: book })?.direction
    ).toBe('BUY');
  });

  it('every tradable regime has an explicit gate branch (no silent default-only)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
    const src = readFileSync(join(here, 'structureEntry.ts'), 'utf8');
    const gateSlice = src.slice(src.indexOf('export function structureGate'));
    for (const r of REGIME_NAMES) {
      expect(gateSlice).toContain(`case '${r}'`);
    }
  });
});
