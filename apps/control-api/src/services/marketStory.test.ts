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
      const mid = 4330 + Math.sin(i / 5) * 0.15; // <1pt total wander
      book.push({
        open_time_ms: m0 + i * 10_000,
        open: mid,
        high: mid + 0.05,
        low: mid - 0.05,
        close: mid + ((i % 2) - 0.5) * 0.02,
        ticks: 6,
      });
    }
    const last = book[book.length - 1]!;
    const story = readMarketStory(book, last);
    expect(story.allow).toBe('NONE');
    expect(story.summary_lv).toMatch(/trek <|chop|GAIDI|šaurs/);
  });

  it('BREAKOUT_UP scalp OK even if last 1m still red (structure pierce is confirm)', () => {
    const story = {
      chapter: 'BREAK_UP' as const,
      allow: 'BUY' as const,
      summary_lv: 'STĀSTS · 30m BREAK UP',
      detail: 'test',
      confidence: 0.8,
      zone_pos: 0.95,
      net_pts: 2,
      red_1m: 4,
      green_1m: 3,
      swing: 'MIXED' as const,
      last_1m: {
        open_time_ms: 0,
        open: 4340,
        high: 4341,
        low: 4335,
        close: 4336, // red
        bars: 6,
      },
    };
    const ok = scalpStoryConfirms(story, 'BUY', 'BREAKOUT_UP');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tag).toMatch(/BREAKOUT OK/);
  });

  it('TREND_UP dip-buy OK when story is RALLY and last 1m is the red dip', () => {
    const story = {
      chapter: 'RALLY' as const,
      allow: 'BUY' as const,
      summary_lv: 'STĀSTS · 30m rally',
      detail: 'test',
      confidence: 0.75,
      zone_pos: 0.4,
      net_pts: 5,
      red_1m: 2,
      green_1m: 8,
      swing: 'HH_HL' as const,
      last_1m: {
        open_time_ms: 0,
        open: 4332,
        high: 4332.5,
        low: 4329,
        close: 4329.5, // red dip
        bars: 6,
      },
    };
    const ok = scalpStoryConfirms(story, 'BUY', 'TREND_UP');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tag).toMatch(/DIP OK|REJECT/);
  });

  it('still blocks knife BUY into BOUNCE_IN_SELL', () => {
    const story = {
      chapter: 'BOUNCE_IN_SELL' as const,
      allow: 'SELL' as const,
      summary_lv: 'STĀSTS · bounce selloffā',
      detail: 'test',
      confidence: 0.85,
      zone_pos: 0.35,
      net_pts: -4,
      red_1m: 8,
      green_1m: 2,
      swing: 'LL_LH' as const,
      last_1m: {
        open_time_ms: 0,
        open: 4328,
        high: 4331,
        low: 4327.5,
        close: 4330.5, // green bounce
        bars: 6,
      },
    };
    expect(scalpStoryConfirms(story, 'BUY', 'RANGE').ok).toBe(false);
    expect(scalpStoryConfirms(story, 'BUY', 'TREND_UP').ok).toBe(false);
    expect(scalpStoryConfirms(story, 'BUY', 'FAILED_BREAKOUT_DOWN').ok).toBe(false);
    expect(scalpStoryConfirms(story, 'BUY', 'REVERSAL_CANDIDATE').ok).toBe(false);
  });

  it('selloff / EXHAUST_LO blocks FAILED_BREAKOUT_DOWN and REVERSAL BUY', () => {
    const { book, last } = selloffBook({ endGreen1m: true });
    const story = readMarketStory(book, last);
    expect(['SELLOFF', 'BOUNCE_IN_SELL', 'BREAK_DOWN', 'EXHAUST_LO']).toContain(story.chapter);
    expect(storyAllowsDirection(story, 'BUY', 'FAILED_BREAKOUT_DOWN').ok).toBe(false);
    expect(storyAllowsDirection(story, 'BUY', 'REVERSAL_CANDIDATE').ok).toBe(false);
    expect(scalpStoryConfirms(story, 'BUY', 'FAILED_BREAKOUT_DOWN', last).ok).toBe(false);
    expect(
      decideEntryWithStructure({
        bar: last,
        regime: 'FAILED_BREAKOUT_DOWN',
        closedBars: book,
      })
    ).toBeNull();
    expect(
      decideEntryWithStructure({
        bar: last,
        regime: 'REVERSAL_CANDIDATE',
        closedBars: book,
      })
    ).toBeNull();
  });

  it('1m DIP OK stays for RALLY TREND_UP; blocked on EXHAUST_HI bare red without reject', () => {
    const rally = {
      chapter: 'RALLY' as const,
      allow: 'BUY' as const,
      summary_lv: 'STĀSTS · 30m rally',
      detail: 'test',
      confidence: 0.75,
      zone_pos: 0.4,
      net_pts: 5,
      red_1m: 2,
      green_1m: 8,
      swing: 'HH_HL' as const,
      last_1m: {
        open_time_ms: 0,
        open: 4332,
        high: 4332.5,
        low: 4329,
        close: 4329.5,
        bars: 6,
      },
    };
    expect(scalpStoryConfirms(rally, 'BUY', 'TREND_UP').ok).toBe(true);

    const exhaust = {
      ...rally,
      chapter: 'EXHAUST_HI' as const,
      zone_pos: 0.9,
      last_1m: {
        open_time_ms: 0,
        open: 4340,
        high: 4340.2,
        low: 4337,
        close: 4337.5, // red, no lower reject
        bars: 6,
      },
    };
    // Chase edge at HI may also block — either way must not bare DIP OK
    const ok = scalpStoryConfirms(exhaust, 'BUY', 'TREND_UP');
    if (ok.ok) expect(ok.tag).not.toMatch(/DIP OK/);
  });

  it('10s trigger starts the leg — does not wait for green closed 1m', () => {
    const story = {
      chapter: 'RALLY' as const,
      allow: 'BUY' as const,
      summary_lv: 'STĀSTS · 30m rally',
      detail: 'test',
      confidence: 0.48,
      zone_pos: 0.32,
      net_pts: 4,
      red_1m: 3,
      green_1m: 6,
      swing: 'HH_HL' as const,
      last_1m: {
        open_time_ms: 0,
        open: 4330,
        high: 4330.4,
        low: 4327,
        close: 4327.5, // still red — move just turning
        bars: 6,
      },
    };
    const trigger = {
      open_time_ms: 10_000,
      open: 4327.5,
      high: 4330,
      low: 4327.2,
      close: 4329.8, // green 10s start
      ticks: 10,
    };
    const ok = scalpStoryConfirms(story, 'BUY', 'TREND_UP', trigger);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tag).toMatch(/10s START GREEN/);
  });

  it('10s red trigger starts SELL leg while last 1m still green', () => {
    const story = {
      chapter: 'SELLOFF' as const,
      allow: 'SELL' as const,
      summary_lv: 'STĀSTS · 30m selloff',
      detail: 'test',
      confidence: 0.5,
      zone_pos: 0.7,
      net_pts: -5,
      red_1m: 7,
      green_1m: 3,
      swing: 'LL_LH' as const,
      last_1m: {
        open_time_ms: 0,
        open: 4340,
        high: 4342,
        low: 4339,
        close: 4341.5, // green bounce before drop resumes
        bars: 6,
      },
    };
    const trigger = {
      open_time_ms: 10_000,
      open: 4341.5,
      high: 4341.8,
      low: 4338,
      close: 4338.5,
      ticks: 10,
    };
    const ok = scalpStoryConfirms(story, 'SELL', 'TREND_DOWN', trigger);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tag).toMatch(/10s START RED/);
  });
});
