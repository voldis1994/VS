import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { REGIME_NAMES, MIN_BARS_FOR_ZONE } from './regimes.js';
import {
  aggregateTenSecToMinutes,
  decideEntryWithStructure,
  lastClosed1mFromTenSec,
  minuteTrendBias,
  structureGate,
  structureStartEntry,
  zoneGeometry,
} from './structureEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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
  it('TREND_UP dip mid-zone: structure OK, full scalp needs 30m story+1m confirm', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4330, lastOpen: 4331.5 });
    const entry = book[book.length - 1]!;
    const raw = decideEntryFrom10sRegime(entry, 'TREND_UP');
    expect(raw?.direction).toBe('BUY');
    const gate = structureGate(
      raw!,
      'TREND_UP',
      entry,
      zoneGeometry(book, entry),
      null,
      'FLAT'
    );
    expect(gate.ok).toBe(true);
    // Quiet mid-zone book often = chop → correctly no arm without 1m story
    const gated = decideEntryWithStructure({
      bar: entry,
      regime: 'TREND_UP',
      closedBars: book,
    });
    if (gated) {
      expect(gated.direction).toBe('BUY');
      expect(gated.reason).toMatch(/1m CONFIRM|STĀSTS/);
    }
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
    // Full path now requires 30m story + 1m scalp confirm — short LO rally book may be chop/sell
    const full = decideEntryWithStructure({
      bar: trigger,
      regime: 'TREND_UP',
      closedBars: book,
    });
    // Either arms with 1m confirm, or correctly waits — never knife-buys selloff
    if (full) {
      expect(full.direction).toBe('BUY');
      expect(full.reason).toMatch(/1m CONFIRM|STĀSTS/);
    }
  });

  it('blocks BUY into multi-1m selloff (08:15 bounce long was wrong)', () => {
    // Simulate ~5 red 1m minutes then a small blue bounce 10s — must NOT BUY
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 6 * 60_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      book.push({
        open_time_ms: m0 - MIN_BARS_FOR_ZONE * 10_000 + i * 10_000,
        open: 4335,
        high: i === 5 ? 4338 : 4335.2,
        low: i === 15 ? 4324 : 4334.8,
        close: 4335,
        ticks: 8,
      });
    }
    // 5 closed red minutes: 4336 → 4327
    for (let m = 0; m < 5; m++) {
      const start = m0 + m * 60_000;
      const o = 4336 - m * 1.5;
      const c = o - 1.2;
      for (let k = 0; k < 6; k++) {
        book.push(bar(o - k * 0.15, o - k * 0.15 - 0.1, start + k * 10_000));
      }
      // ensure last of minute near c
      book[book.length - 1] = bar(c + 0.2, c, start + 50_000);
    }
    // Bounce 10s rally in lower half — classic knife catch
    const trigger = bar(4327.0, 4327.8, m0 + 5 * 60_000);
    book.push(trigger);

    expect(minuteTrendBias(book)).toBe('DOWN');

    const fadeBuy = decideEntryWithStructure({
      bar: trigger,
      regime: 'RANGE',
      closedBars: book,
    });
    // RANGE fade BUY or structure-start must not arm against DOWN bias
    expect(fadeBuy).toBeNull();

    const dipBar = bar(4328.5, 4327.5, m0 + 5 * 60_000 + 10_000);
    const trendUp = decideEntryWithStructure({
      bar: dipBar,
      regime: 'TREND_UP',
      closedBars: [...book, dipBar],
    });
    expect(trendUp).toBeNull();
  });

  it('every tradable regime has an explicit gate branch (no silent default-only)', () => {
    const src = readFileSync(join(here, 'structureEntry.ts'), 'utf8');
    const gateSlice = src.slice(src.indexOf('export function structureGate'));
    for (const r of REGIME_NAMES) {
      expect(gateSlice).toContain(`case '${r}'`);
    }
  });
});

describe('14-regime audit — no net/trek / mid-fake / wait-only bugs', () => {
  function selloffVBook(): TenSecBar[] {
    // Dump then bounce: trek ~8pt, net near 0 — must stay DOWN bias
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 7 * 60_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      book.push({
        open_time_ms: m0 - MIN_BARS_FOR_ZONE * 10_000 + i * 10_000,
        open: 4335,
        high: i === 5 ? 4338 : 4335.2,
        low: i === 15 ? 4328 : 4334.8,
        close: 4335,
        ticks: 8,
      });
    }
    // 4 red dump minutes
    for (let m = 0; m < 4; m++) {
      const start = m0 + m * 60_000;
      const o = 4336 - m * 1.8;
      const c = o - 1.5;
      for (let k = 0; k < 6; k++) {
        book.push(bar(o - k * 0.2, o - k * 0.2 - 0.12, start + k * 10_000));
      }
      book[book.length - 1] = bar(c + 0.2, c, start + 50_000);
    }
    // 2 green bounce minutes that recover most of the net
    for (let m = 4; m < 6; m++) {
      const start = m0 + m * 60_000;
      const o = 4329 + (m - 4) * 2.5;
      const c = o + 2.2;
      for (let k = 0; k < 6; k++) {
        book.push(bar(o + k * 0.3, o + k * 0.3 + 0.2, start + k * 10_000));
      }
      book[book.length - 1] = bar(c - 0.2, c, start + 50_000);
    }
    return book;
  }

  it('minuteTrendBias uses trek — V-bounce selloff stays DOWN (net≈0 ≠ FLAT)', () => {
    const book = selloffVBook();
    expect(minuteTrendBias(book)).toBe('DOWN');
  });

  it('BREAKOUT_UP mid-zone 0.55 is fake — rejected; pierce OK', () => {
    const midBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4331, lastOpen: 4329.5 });
    const midEntry = midBook[midBook.length - 1]!;
    const sig = { direction: 'BUY' as const, setup: 'BREAKOUT' as const, reason: 'fake' };
    expect(
      structureGate(sig, 'BREAKOUT_UP', midEntry, zoneGeometry(midBook, midEntry), null).ok
    ).toBe(false);

    const pierceBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4341, lastOpen: 4339 });
    const pierce = pierceBook[pierceBook.length - 1]!;
    expect(
      structureGate(sig, 'BREAKOUT_UP', pierce, zoneGeometry(pierceBook, pierce), null).ok
    ).toBe(true);
  });

  it('BREAKOUT_DOWN mid-zone rejected; pierce OK', () => {
    const midBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4329, lastOpen: 4330.5 });
    const midEntry = midBook[midBook.length - 1]!;
    const sig = { direction: 'SELL' as const, setup: 'BREAKOUT' as const, reason: 'fake' };
    expect(
      structureGate(sig, 'BREAKOUT_DOWN', midEntry, zoneGeometry(midBook, midEntry), null).ok
    ).toBe(false);

    const pierceBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4319, lastOpen: 4321 });
    const pierce = pierceBook[pierceBook.length - 1]!;
    expect(
      structureGate(sig, 'BREAKOUT_DOWN', pierce, zoneGeometry(pierceBook, pierce), null).ok
    ).toBe(true);
  });

  it('EXPANSION allows LO BUY / HI SELL start — blocks weak opposite half', () => {
    const loBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4325, lastOpen: 4322 });
    const lo = loBook[loBook.length - 1]!;
    const buy = { direction: 'BUY' as const, setup: 'BREAKOUT' as const, reason: 'exp' };
    // Rally from LO = start of expansion leg
    expect(structureGate(buy, 'EXPANSION', lo, zoneGeometry(loBook, lo), null).ok).toBe(true);

    const hiBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4336, lastOpen: 4339 });
    const hi = hiBook[hiBook.length - 1]!;
    const sell = { direction: 'SELL' as const, setup: 'BREAKOUT' as const, reason: 'exp' };
    expect(structureGate(sell, 'EXPANSION', hi, zoneGeometry(hiBook, hi), null).ok).toBe(true);

    // Flat micro bar mid-zone — not an expansion impulse
    const midBook = zoneBook({
      lo: 4320,
      hi: 4340,
      lastClose: 4330.01,
      lastOpen: 4330,
    });
    const mid = midBook[midBook.length - 1]!;
    expect(structureGate(buy, 'EXPANSION', mid, zoneGeometry(midBook, mid), null).ok).toBe(false);
  });

  it('COMPRESSION + TRANSITION + UNKNOWN are wait-only at the gate', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4324, lastOpen: 4325.5 });
    const entry = book[book.length - 1]!;
    const z = zoneGeometry(book, entry);
    const buy = { direction: 'BUY' as const, setup: 'FADE' as const, reason: 'x' };
    expect(structureGate(buy, 'COMPRESSION', entry, z, null).ok).toBe(false);
    expect(structureGate(buy, 'TRANSITION', entry, z, null).ok).toBe(false);
    expect(structureGate(buy, 'UNKNOWN', entry, z, null).ok).toBe(false);
  });

  it('no continuation regime knife-buys into V-bounce selloff bias', () => {
    const book = selloffVBook();
    const trigger = bar(4334.0, 4334.8, Math.floor(Date.now() / 60_000) * 60_000 - 10_000);
    book.push(trigger);
    expect(minuteTrendBias(book)).toBe('DOWN');

    // Counter-trend fades (FAILED_BREAKOUT_DOWN / REVERSAL) may still BUY by design
    const continuation = [
      'RANGE',
      'TREND_UP',
      'TREND_DOWN',
      'PULLBACK_UPTREND',
      'PULLBACK_DOWNTREND',
      'COMPRESSION',
      'EXPANSION',
      'BREAKOUT_UP',
      'BREAKOUT_DOWN',
      'FAILED_BREAKOUT_UP',
      'TRANSITION',
      'UNKNOWN',
    ] as const;

    for (const regime of continuation) {
      const armed = decideEntryWithStructure({
        bar: trigger,
        regime,
        closedBars: book,
      });
      if (armed) {
        expect(armed.direction, regime).not.toBe('BUY');
      }
    }
  });

  it('TREND_UP / TREND_DOWN wrong-side and chase are rejected', () => {
    const hiBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4338, lastOpen: 4336.5 });
    const hi = hiBook[hiBook.length - 1]!;
    const buy = { direction: 'BUY' as const, setup: 'CONTINUATION' as const, reason: 'chase' };
    const sell = { direction: 'SELL' as const, setup: 'CONTINUATION' as const, reason: 'wrong' };
    expect(
      structureGate(sell, 'TREND_UP', hi, zoneGeometry(hiBook, hi), null, 'FLAT').ok
    ).toBe(false);
    expect(
      structureGate(buy, 'TREND_UP', hi, zoneGeometry(hiBook, hi), { open_time_ms: 0, open: 4330, high: 4339, low: 4329, close: 4338, bars: 6 }, 'FLAT').ok
    ).toBe(false);

    const loBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4322, lastOpen: 4323.5 });
    const lo = loBook[loBook.length - 1]!;
    expect(
      structureGate(buy, 'TREND_DOWN', lo, zoneGeometry(loBook, lo), null, 'FLAT').ok
    ).toBe(false);
  });

  it('BUY vs DOWN bias is always blocked (no LO knife exception)', () => {
    const loBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4324, lastOpen: 4322 });
    const lo = loBook[loBook.length - 1]!;
    const buy = { direction: 'BUY' as const, setup: 'PULLBACK' as const, reason: 'knife' };
    expect(
      structureGate(buy, 'TREND_UP', lo, zoneGeometry(loBook, lo), null, 'DOWN').ok
    ).toBe(false);

    const midBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4332, lastOpen: 4330 });
    const mid = midBook[midBook.length - 1]!;
    expect(
      structureGate(buy, 'TREND_UP', mid, zoneGeometry(midBook, mid), null, 'DOWN').ok
    ).toBe(false);
  });

  it('structure start does not fire BUY into DOWN bias', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4325, lastOpen: 4322 });
    const trigger = book[book.length - 1]!;
    const z = zoneGeometry(book, trigger);
    const m1Red = {
      open_time_ms: 0,
      open: 4330,
      high: 4331,
      low: 4324,
      close: 4325,
      bars: 6,
    };
    expect(structureStartEntry(trigger, 'TREND_UP', z, m1Red, 'DOWN')).toBeNull();
    // With agreeing bias, 10s rally can start without waiting for green 1m
    expect(structureStartEntry(trigger, 'TREND_UP', z, m1Red, 'FLAT')?.direction).toBe('BUY');
  });

  it('FAILED_BREAKOUT sides stay near the failed edge', () => {
    const loBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4323, lastOpen: 4324.5 });
    const lo = loBook[loBook.length - 1]!;
    const sell = { direction: 'SELL' as const, setup: 'FADE' as const, reason: 'far' };
    expect(
      structureGate(sell, 'FAILED_BREAKOUT_UP', lo, zoneGeometry(loBook, lo), null).ok
    ).toBe(false);

    const hiBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4337, lastOpen: 4335.5 });
    const hi = hiBook[hiBook.length - 1]!;
    const buy = { direction: 'BUY' as const, setup: 'FADE' as const, reason: 'far' };
    expect(
      structureGate(buy, 'FAILED_BREAKOUT_DOWN', hi, zoneGeometry(hiBook, hi), null).ok
    ).toBe(false);
  });
});
