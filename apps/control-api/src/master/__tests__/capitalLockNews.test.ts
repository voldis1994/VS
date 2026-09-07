import { describe, expect, it } from 'vitest';
import {
  createLoginLockState,
  loginLockHeld,
  withLoginLock,
} from '../capitalLoginLock.js';
import {
  clearNewsCalendarCacheForTest,
  currenciesForSymbol,
  isNewsCalendarBlocked,
  setNewsCalendarCacheForTest,
} from '../newsCalendar.js';
import { newsBlocksEntries, resolveNewsWindow } from '../newsGate.js';

describe('Capital login lock', () => {
  it('queues sibling callers instead of barging in', async () => {
    const state = createLoginLockState();
    const order: string[] = [];

    const a = withLoginLock(state, async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('A-end');
    });
    const b = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      await withLoginLock(state, async () => {
        order.push('B-start');
        order.push('B-end');
      });
    })();

    await Promise.all([a, b]);
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('allows nested reentry in the same async context', async () => {
    const state = createLoginLockState();
    const order: string[] = [];

    await withLoginLock(state, async () => {
      order.push('outer');
      expect(loginLockHeld()).toBe(true);
      await withLoginLock(state, async () => {
        order.push('inner');
        expect(loginLockHeld()).toBe(true);
      });
    });

    expect(order).toEqual(['outer', 'inner']);
    expect(loginLockHeld()).toBe(false);
  });
});

describe('Forex Factory news calendar', () => {
  it('maps GOLD → USD', () => {
    expect(currenciesForSymbol('GOLD')).toEqual(['USD']);
    expect(currenciesForSymbol('EURUSD')).toEqual(['EUR', 'USD']);
  });

  it('blocks GOLD during high-impact USD window from cache', () => {
    clearNewsCalendarCacheForTest();
    const now = Date.now();
    setNewsCalendarCacheForTest([
      {
        title: 'FOMC Statement',
        country: 'USD',
        date: new Date(now).toISOString(),
        impact: 'High',
      },
    ]);
    const block = isNewsCalendarBlocked({
      symbol: 'GOLD',
      nowMs: now,
      minutesBefore: 30,
      minutesAfter: 15,
    });
    expect(block.blocked).toBe(true);
    expect(block.reason).toMatch(/FOMC|news_calendar/i);

    const gate = resolveNewsWindow(now, 'GOLD');
    expect(gate.window_active).toBe(true);
    expect(gate.source).toBe('calendar_ff');
    expect(newsBlocksEntries(true, now, 'GOLD').blocked).toBe(true);
    clearNewsCalendarCacheForTest();
  });

  it('ignores EUR-only news for GOLD', () => {
    clearNewsCalendarCacheForTest();
    const now = Date.now();
    setNewsCalendarCacheForTest([
      {
        title: 'ECB Rate',
        country: 'EUR',
        date: new Date(now).toISOString(),
        impact: 'High',
      },
    ]);
    expect(
      isNewsCalendarBlocked({ symbol: 'GOLD', nowMs: now }).blocked
    ).toBe(false);
    clearNewsCalendarCacheForTest();
  });
});
