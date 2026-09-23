import { describe, expect, it } from 'vitest';
import { MIN_BARS_FOR_ZONE } from './regimes.js';
import {
  readMarketStory,
  storyAllowsDirection,
  scalpStoryConfirms,
} from './marketStory.js';
import { decideEntryWithStructure } from './structureEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, t: number, pad = 0.15): TenSecBar {
  return {
    open_time_ms: t,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad * 0.4,
    close,
    ticks: 8,
  };
}

function selloffBook(opts?: { endGreen1m?: boolean }): { book: TenSecBar[]; last: TenSecBar } {
  const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 20 * 60_000;
  const book: TenSecBar[] = [];
  for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
    book.push({
      open_time_ms: m0 - MIN_BARS_FOR_ZONE * 10_000 + i * 10_000,
      open: 4335,
      high: i === 3 ? 4338 : 4335.3,
      low: i === 10 ? 4328 : 4334.7,
      close: 4335,
      ticks: 6,
    });
  }
  for (let m = 0; m < 12; m++) {
    const start = m0 + m * 60_000;
    const o = 4336 - m * 1.0;
    const c = o - 0.8;
    for (let k = 0; k < 6; k++) {
      book.push(bar(o - k * 0.1, o - k * 0.1 - 0.08, start + k * 10_000));
    }
    book[book.length - 1] = bar(c + 0.15, c, start + 50_000);
  }
  if (opts?.endGreen1m) {
    const start = m0 + 12 * 60_000;
    for (let k = 0; k < 6; k++) {
      book.push(bar(4324 + k * 0.15, 4324 + k * 0.15 + 0.1, start + k * 10_000));
    }
  }
  const last = book[book.length - 1]!;
  return { book, last };
}

describe('30m market story — 1m scalp grade', () => {
  it('selloff blocks BUY; SELL needs 1m confirm and no LO chase', () => {
    const { book, last } = selloffBook();
    const story = readMarketStory(book, last);
    expect(['SELLOFF', 'BOUNCE_IN_SELL', 'BREAK_DOWN', 'EXHAUST_LO']).toContain(story.chapter);
    expect(storyAllowsDirection(story, 'BUY', 'RANGE').ok).toBe(false);

    const sell = scalpStoryConfirms(story, 'SELL', 'TREND_DOWN');
    if (story.zone_pos != null && story.zone_pos <= 0.25 && story.chapter !== 'BREAK_DOWN') {
      expect(sell.ok).toBe(false);
    } else {
      expect(sell.ok).toBe(true);
    }

    expect(
      decideEntryWithStructure({ bar: last, regime: 'RANGE', closedBars: book })
    ).toBeNull();
  });

  it('green bounce in selloff does not allow BUY scalp', () => {
    const { book, last } = selloffBook({ endGreen1m: true });
    const story = readMarketStory(book, last);
    expect(scalpStoryConfirms(story, 'BUY', 'RANGE').ok).toBe(false);
  });

  it('V-bounce selloff (net≈0, trek large) is SELLOFF not "troksnis"', () => {
    // Reproduces 09:07 Gold: dump → bounce → dump, net small, trek ~7pt, pos near LO
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 35 * 60_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      book.push({
        open_time_ms: m0 + i * 10_000,
        open: 4324,
        high: i === 2 ? 4327.5 : 4324.2,
        low: i === 8 ? 4320 : 4323.8,
        close: 4324,
        ticks: 6,
      });
    }
    // Dump 4327 → 4319
    for (let m = 0; m < 8; m++) {
      const start = m0 + MIN_BARS_FOR_ZONE * 10_000 + m * 60_000;
      const o = 4327 - m * 1.0;
      const c = o - 0.9;
      for (let k = 0; k < 6; k++) book.push(bar(o - k * 0.12, o - k * 0.12 - 0.1, start + k * 10_000));
      book[book.length - 1] = bar(c + 0.2, c, start + 50_000);
    }
    // Bounce to ~4325
    for (let m = 0; m < 5; m++) {
      const start = m0 + MIN_BARS_FOR_ZONE * 10_000 + (8 + m) * 60_000;
      const o = 4319.5 + m * 1.0;
      const c = o + 0.8;
      for (let k = 0; k < 6; k++) book.push(bar(o + k * 0.1, o + k * 0.1 + 0.08, start + k * 10_000));
      book[book.length - 1] = bar(c - 0.15, c, start + 50_000);
    }
    // Dump again to ~4319
    for (let m = 0; m < 5; m++) {
      const start = m0 + MIN_BARS_FOR_ZONE * 10_000 + (13 + m) * 60_000;
      const o = 4325 - m * 1.1;
      const c = o - 1.0;
      for (let k = 0; k < 6; k++) book.push(bar(o - k * 0.12, o - k * 0.12 - 0.1, start + k * 10_000));
      book[book.length - 1] = bar(c + 0.2, c, start + 50_000);
    }
    const last = book[book.length - 1]!;
    const story = readMarketStory(book, last);
    expect(story.summary_lv).not.toMatch(/troksnis|ceļš </);
    expect(['SELLOFF', 'BOUNCE_IN_SELL', 'BREAK_DOWN', 'EXHAUST_LO']).toContain(story.chapter);
    expect(story.allow).toBe('SELL');
    expect(storyAllowsDirection(story, 'BUY', 'RANGE').ok).toBe(false);
  });

  it('tiny trek (<3pt) stays GAIDI', () => {
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 15 * 60_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE + 60; i++) {
      const mid = 4330 + Math.sin(i / 3) * 0.4;
      book.push(bar(mid, mid + ((i % 2) - 0.5) * 0.05, m0 + i * 10_000, 0.08));
    }
    const last = book[book.length - 1]!;
    const story = readMarketStory(book, last);
    expect(story.allow).toBe('NONE');
    expect(story.summary_lv).toMatch(/trek <|chop|GAIDI/);
  });
});
