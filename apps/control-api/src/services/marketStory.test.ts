import { describe, expect, it } from 'vitest';
import { MIN_BARS_FOR_ZONE } from './regimes.js';
import { readMarketStory, storyAllowsDirection } from './marketStory.js';
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

/** ~30m pad + N red 1m minutes (selloff like 08:00→08:15 Gold). */
function selloffBook(): { book: TenSecBar[]; bounce: TenSecBar } {
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
  // 12 red minutes lower highs / lower lows
  for (let m = 0; m < 12; m++) {
    const start = m0 + m * 60_000;
    const o = 4336 - m * 1.0;
    const c = o - 0.8;
    for (let k = 0; k < 6; k++) {
      book.push(bar(o - k * 0.1, o - k * 0.1 - 0.08, start + k * 10_000));
    }
    book[book.length - 1] = bar(c + 0.15, c, start + 50_000);
  }
  const bounce = bar(4325.0, 4326.2, m0 + 12 * 60_000);
  book.push(bounce);
  return { book, bounce };
}

describe('30m market story (human chart reading)', () => {
  it('labels selloff + blocks BUY on bounce (08:15 style knife)', () => {
    const { book, bounce } = selloffBook();
    const story = readMarketStory(book, bounce);
    expect(['SELLOFF', 'BOUNCE_IN_SELL', 'BREAK_DOWN', 'EXHAUST_LO']).toContain(story.chapter);
    expect(story.summary_lv).toMatch(/STĀSTS/);
    expect(storyAllowsDirection(story, 'BUY', 'RANGE').ok).toBe(false);
    expect(storyAllowsDirection(story, 'SELL', 'RANGE').ok).toBe(true);

    const armed = decideEntryWithStructure({
      bar: bounce,
      regime: 'RANGE',
      closedBars: book,
    });
    expect(armed).toBeNull();
  });

  it('rally story allows BUY only', () => {
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 20 * 60_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) {
      book.push({
        open_time_ms: m0 - MIN_BARS_FOR_ZONE * 10_000 + i * 10_000,
        open: 4320,
        high: i === 10 ? 4328 : 4320.3,
        low: i === 3 ? 4316 : 4319.7,
        close: 4320,
        ticks: 6,
      });
    }
    for (let m = 0; m < 12; m++) {
      const start = m0 + m * 60_000;
      const o = 4318 + m * 1.0;
      const c = o + 0.8;
      for (let k = 0; k < 6; k++) {
        book.push(bar(o + k * 0.1, o + k * 0.1 + 0.08, start + k * 10_000));
      }
      book[book.length - 1] = bar(c - 0.15, c, start + 50_000);
    }
    const last = book[book.length - 1]!;
    const story = readMarketStory(book, last);
    expect(['RALLY', 'DIP_IN_RALLY', 'BREAK_UP', 'EXHAUST_HI']).toContain(story.chapter);
    expect(storyAllowsDirection(story, 'SELL', 'RANGE').ok).toBe(false);
    expect(storyAllowsDirection(story, 'BUY', 'TREND_UP').ok).toBe(true);
  });
});
