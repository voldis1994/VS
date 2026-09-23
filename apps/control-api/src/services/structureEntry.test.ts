import { describe, expect, it } from 'vitest';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { MIN_BARS_FOR_ZONE } from './regimes.js';
import {
  aggregateTenSecToMinutes,
  decideEntryWithStructure,
  lastClosed1mFromTenSec,
  structureGate,
  structureStartEntry,
  zoneGeometry,
} from './structureEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(
  open: number,
  close: number,
  t = 0,
  pad = 0.2
): TenSecBar {
  return {
    open_time_ms: t,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad * 0.5,
    close,
    ticks: 10,
  };
}

/** Quiet zone then price at a given close — enough bars for zone_ready */
function zoneBook(opts: {
  lo: number;
  hi: number;
  lastClose: number;
  lastOpen?: number;
  baseMs?: number;
}): TenSecBar[] {
  const baseMs = opts.baseMs ?? 1_700_000_000_000;
  const mid = (opts.lo + opts.hi) / 2;
  const out: TenSecBar[] = [];
  for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
    const wobble = (i % 7) * 0.05;
    const o = mid + wobble;
    const c = mid - wobble * 0.5;
    out.push({
      open_time_ms: baseMs + i * 10_000,
      open: o,
      high: Math.min(opts.hi - 0.05, Math.max(o, c) + 0.15),
      low: Math.max(opts.lo + 0.05, Math.min(o, c) - 0.15),
      close: c,
      ticks: 8,
    });
  }
  // Paint extremes into prior so hi/lo match intent
  out[10] = {
    ...out[10]!,
    high: opts.hi,
    low: mid,
    open: mid,
    close: mid + 0.1,
  };
  out[20] = {
    ...out[20]!,
    high: mid,
    low: opts.lo,
    open: mid,
    close: mid - 0.1,
  };
  const lastOpen = opts.lastOpen ?? opts.lastClose;
  const t = baseMs + MIN_BARS_FOR_ZONE * 10_000;
  out.push(bar(lastOpen, opts.lastClose, t, 0.25));
  return out;
}

describe('10s → 1m aggregate', () => {
  it('builds 6×10s into one minute candle', () => {
    const start = 1_700_000_000_000;
    // Align to minute
    const minute = Math.floor(start / 60_000) * 60_000;
    const bars: TenSecBar[] = [];
    for (let k = 0; k < 6; k++) {
      bars.push(bar(100 + k * 0.1, 100 + k * 0.1 + 0.05, minute + k * 10_000));
    }
    const mins = aggregateTenSecToMinutes(bars);
    expect(mins).toHaveLength(1);
    expect(mins[0]!.open).toBe(bars[0]!.open);
    expect(mins[0]!.close).toBe(bars[5]!.close);
    expect(mins[0]!.bars).toBe(6);
  });

  it('lastClosed1mFromTenSec skips forming wall-clock minute', () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
    const bars: TenSecBar[] = [];
    for (let k = 0; k < 6; k++) {
      bars.push(bar(2000, 2000.4, minute + k * 10_000));
    }
    const m = lastClosed1mFromTenSec(bars);
    expect(m).not.toBeNull();
    expect(m!.close).toBeGreaterThan(m!.open);
  });
});

describe('zone geometry', () => {
  it('reports LO when last close near zone floor', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4322, lastOpen: 4323 });
    const z = zoneGeometry(book);
    expect(z).not.toBeNull();
    expect(z!.pos).toBeLessThan(0.42);
    expect(['LO', 'MID_LO']).toContain(z!.band);
  });

  it('reports HI when last close near zone ceiling', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4338, lastOpen: 4337 });
    const z = zoneGeometry(book);
    expect(z).not.toBeNull();
    expect(z!.pos).toBeGreaterThan(0.58);
  });
});

describe('structure vs chase', () => {
  it('structure-start BUY from zone LO when 1m UP + 10s rally (1m chart leg)', () => {
    // Two closed minutes ago (wall-clock safe) so lastClosed1m is not forming
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
    const book: TenSecBar[] = [];
    // ~15m quiet zone with clear hi/lo
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      const t = m0 - MIN_BARS_FOR_ZONE * 10_000 + i * 10_000;
      const mid = 4330;
      book.push({
        open_time_ms: t,
        open: mid,
        high: i === 5 ? 4340 : mid + 0.3,
        low: i === 15 ? 4320 : mid - 0.3,
        close: mid + ((i % 3) - 1) * 0.05,
        ticks: 8,
      });
    }
    // Closed 1m UP near the floor (structure leg on 1m chart)
    for (let k = 0; k < 6; k++) {
      const o = 4321 + k * 0.2;
      book.push(bar(o, o + 0.15, m0 + k * 10_000, 0.1));
    }
    // Trigger 10s rally still in LO band (next minute start, already "closed" in book)
    const trigger = bar(4323.0, 4324.2, m0 + 60_000, 0.15);
    book.push(trigger);

    const z = zoneGeometry(book);
    expect(z).not.toBeNull();
    expect(z!.pos).toBeLessThanOrEqual(0.42);

    const m1 = {
      open_time_ms: m0,
      open: 4321,
      high: 4323,
      low: 4320.5,
      close: 4322.8,
      bars: 6,
    };
    const started = structureStartEntry(trigger, 'TREND_UP', z, m1);
    expect(started?.direction).toBe('BUY');
    expect(started?.setup).toBe('CONTINUATION');

    // Gate + full path: inject bullish closed 1m via book already UP in m0
    const full = decideEntryWithStructure({
      bar: trigger,
      regime: 'TREND_UP',
      closedBars: book,
    });
    // May arm via structure-start or raw dip; must not be chase-rejected
    expect(full?.direction).toBe('BUY');
  });

  it('rejects FADE BUY mid-zone (chase), allows at LO', () => {
    const midBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4330, lastOpen: 4331 });
    const lastMid = midBook[midBook.length - 1]!;
    const rawMid = decideEntryFrom10sRegime(lastMid, 'RANGE');
    // force fade buy shape
    const fadeBuy = rawMid ?? {
      direction: 'BUY' as const,
      setup: 'FADE' as const,
      reason: 'test fade',
    };
    if (fadeBuy.direction === 'BUY' && fadeBuy.setup === 'FADE') {
      const z = zoneGeometry(midBook)!;
      const gate = structureGate(fadeBuy, 'RANGE', lastMid, z, null);
      expect(gate.ok).toBe(false);
    }

    const loBook = zoneBook({ lo: 4320, hi: 4340, lastClose: 4322, lastOpen: 4323.5 });
    const lastLo = loBook[loBook.length - 1]!;
    const fadeAtLo = {
      direction: 'BUY' as const,
      setup: 'FADE' as const,
      reason: 'RANGE fade dip',
    };
    const gateLo = structureGate(fadeAtLo, 'RANGE', lastLo, zoneGeometry(loBook), null);
    expect(gateLo.ok).toBe(true);
  });

  it('rejects BUY chase into HI with 1m UP (non-breakout)', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4337, lastOpen: 4338.5 });
    const last = book[book.length - 1]!;
    const sig = {
      direction: 'BUY' as const,
      setup: 'PULLBACK' as const,
      reason: 'TREND_UP dip',
    };
    const m1 = {
      open_time_ms: 0,
      open: 4335,
      high: 4338,
      low: 4334,
      close: 4337.5,
      bars: 6,
    };
    const gate = structureGate(sig, 'TREND_UP', last, zoneGeometry(book), m1);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toMatch(/chase/i);
  });

  it('raw TREND_UP dip at support still passes structure gate', () => {
    const book = zoneBook({ lo: 4320, hi: 4340, lastClose: 4323, lastOpen: 4324.5 });
    const last = book[book.length - 1]!;
    const raw = decideEntryFrom10sRegime(last, 'TREND_UP');
    expect(raw?.direction).toBe('BUY');
    const gated = decideEntryWithStructure({
      bar: last,
      regime: 'TREND_UP',
      closedBars: book,
    });
    expect(gated?.direction).toBe('BUY');
  });
});
