import { describe, expect, it, beforeEach } from 'vitest';
import { decideEntryWithStructure, structureGate } from './structureEntry.js';
import { MIN_BARS_FOR_ZONE } from './regimes.js';
import { _setTradeOpenAtStartForTests } from './tradeOpenPolicy.js';
import type { TenSecBar } from './tenSecondOhlc.js';

_setTradeOpenAtStartForTests(false);

function bar(open: number, close: number, t: number, pad = 0.2): TenSecBar {
  return {
    open_time_ms: t,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad * 0.5,
    close,
    ticks: 10,
  };
}

function zoneBook(lo: number, hi: number, lastOpen: number, lastClose: number): TenSecBar[] {
  const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 20 * 60_000;
  const book: TenSecBar[] = [];
  const mid = (lo + hi) / 2;
  for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
    const wobble = ((i % 5) - 2) * ((hi - lo) / 20);
    const c = mid + wobble;
    book.push({
      open_time_ms: m0 + i * 10_000,
      open: c,
      high: i === 3 ? hi : c + 0.3,
      low: i === 10 ? lo : c - 0.3,
      close: c,
      ticks: 8,
    });
  }
  book.push(bar(lastOpen, lastClose, m0 + MIN_BARS_FOR_ZONE * 10_000, 0.15));
  return book;
}

describe('RANGE must not tip-chase breakout / fake-breakout', () => {
  beforeEach(() => _setTradeOpenAtStartForTests(false));

  it('structureGate blocks RANGE BUY tip-chase at HI with green bar', () => {
    const book = zoneBook(4320, 4340, 4338, 4339.5);
    const last = book[book.length - 1]!;
    const zone = {
      hi: 4340,
      lo: 4320,
      mid: 4330,
      width: 20,
      pos: 0.95,
      band: 'HI' as const,
    };
    const g = structureGate(
      { direction: 'BUY', setup: 'FADE', reason: 'tip' },
      'RANGE',
      last,
      zone,
      null
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/tip-chase|not in lower half/i);
  });

  it('structureGate blocks RANGE SELL tip-chase at HI with green bar (breakout lookalike)', () => {
    const last = bar(4338, 4339.5, Date.now());
    const zone = {
      hi: 4340,
      lo: 4320,
      mid: 4330,
      width: 20,
      pos: 0.95,
      band: 'HI' as const,
    };
    const g = structureGate(
      { direction: 'SELL', setup: 'FADE', reason: 'tip fade' },
      'RANGE',
      last,
      zone,
      null
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/tip-chase HI/i);
  });

  it('structureGate blocks RANGE BUY tip-chase at LO with red bar (breakdown lookalike)', () => {
    const last = bar(4322, 4320.5, Date.now());
    const zone = {
      hi: 4340,
      lo: 4320,
      mid: 4330,
      width: 20,
      pos: 0.05,
      band: 'LO' as const,
    };
    const g = structureGate(
      { direction: 'BUY', setup: 'FADE', reason: 'tip fade' },
      'RANGE',
      last,
      zone,
      null
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/tip-chase LO/i);
  });

  it('structureGate blocks COMPRESSION/TRANSITION tip-chase same as RANGE', () => {
    const hiBar = bar(4338, 4339.5, Date.now());
    const loBar = bar(4322, 4320.5, Date.now());
    const hiZ = {
      hi: 4340,
      lo: 4320,
      mid: 4330,
      width: 20,
      pos: 0.95,
      band: 'HI' as const,
    };
    const loZ = { ...hiZ, pos: 0.05, band: 'LO' as const };
    for (const regime of ['COMPRESSION', 'TRANSITION'] as const) {
      expect(
        structureGate(
          { direction: 'SELL', setup: 'FADE', reason: 'tip' },
          regime,
          hiBar,
          hiZ,
          null
        ).ok
      ).toBe(false);
      expect(
        structureGate(
          { direction: 'BUY', setup: 'FADE', reason: 'tip' },
          regime,
          loBar,
          loZ,
          null
        ).ok
      ).toBe(false);
    }
  });

  it('structureGate allows RANGE SELL fade at HI after reject dip (not tip-chase)', () => {
    const last = bar(4339, 4337.5, Date.now()); // red reject at HI
    const zone = {
      hi: 4340,
      lo: 4320,
      mid: 4330,
      width: 20,
      pos: 0.9,
      band: 'HI' as const,
    };
    const g = structureGate(
      { direction: 'SELL', setup: 'FADE', reason: 'reject' },
      'RANGE',
      last,
      zone,
      null
    );
    expect(g.ok).toBe(true);
  });

  it('structureGate blocks RANGE SELL tip-chase at LO with red bar', () => {
    const book = zoneBook(4320, 4340, 4322, 4320.5);
    const last = book[book.length - 1]!;
    const zone = {
      hi: 4340,
      lo: 4320,
      mid: 4330,
      width: 20,
      pos: 0.05,
      band: 'LO' as const,
    };
    const g = structureGate(
      { direction: 'SELL', setup: 'FADE', reason: 'tip' },
      'RANGE',
      last,
      zone,
      null
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/tip-chase|not in upper half/i);
  });

  it('decideEntry: EXHAUST_HI never RANGE BUY knife (flat HTF)', () => {
    const book = zoneBook(4320, 4340, 4337, 4338.5);
    // Build enough 1m for story; tip near HI green
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 25 * 60_000;
    const rich: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      rich.push({
        open_time_ms: m0 + i * 10_000,
        open: 4330,
        high: i === 5 ? 4340 : 4330.4,
        low: i === 15 ? 4320 : 4329.6,
        close: 4330,
        ticks: 8,
      });
    }
    for (let m = 0; m < 12; m++) {
      const start = m0 + MIN_BARS_FOR_ZONE * 10_000 + m * 60_000;
      const o = 4325 + m * 1.1;
      for (let k = 0; k < 6; k++) {
        rich.push(bar(o + k * 0.1, o + k * 0.1 + 0.08, start + k * 10_000));
      }
    }
    const tip = bar(4337, 4339, m0 + MIN_BARS_FOR_ZONE * 10_000 + 12 * 60_000);
    rich.push(tip);
    const sig = decideEntryWithStructure({
      bar: tip,
      regime: 'RANGE',
      closedBars: rich,
      capital_m1_dir: 'FLAT',
      capital_tf5_dir: 'FLAT',
      capital_tf15_dir: 'FLAT',
      capital_tf30_dir: 'FLAT',
    });
    if (sig) {
      expect(sig.direction).not.toBe('BUY');
      expect(sig.setup).not.toBe('BREAKOUT');
    }
  });
});
