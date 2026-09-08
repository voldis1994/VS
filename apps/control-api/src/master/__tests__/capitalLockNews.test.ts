import { describe, expect, it, afterEach } from 'vitest';
import { CapitalBroker } from '../broker.js';
import {
  clearSharedLoginLocks,
  createLoginLockState,
  loginLockHeld,
  sharedLoginLockForConnection,
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
  afterEach(() => {
    clearSharedLoginLocks();
    delete process.env.MASTER_LIVE_ENABLED;
    delete process.env.MASTER_CONFIRM_FAST;
  });

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

  it('shares login lock across CapitalBroker instances on same connectionId', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    const order: string[] = [];
    const mk = (tag: string) =>
      new CapitalBroker({
        credentials: { connectionId: 900042 },
        acquire: async () => ({ ok: true, session: { id: tag }, detail: 'ok' }),
        quote: async (_s, epic) => ({
          bid: 4410,
          ask: 4410.4,
          mid: 4410.2,
          epic,
          raw_ok: true,
        }),
        list: async () => ({ ok: true, positions: [], detail: '' }),
        create: async () => ({ ok: false, detail: 'unused' }),
        close: async () => {
          order.push(`${tag}-start`);
          await new Promise((r) => setTimeout(r, 40));
          order.push(`${tag}-end`);
          return { ok: true, detail: 'closed' };
        },
      });
    const a = mk('A');
    const b = mk('B');
    expect(sharedLoginLockForConnection(900042)).toBe(
      sharedLoginLockForConnection(900042)
    );
    await a.connect();
    await b.connect();
    await Promise.all([a.closePosition('x'), b.closePosition('y')]);
    const aStart = order.indexOf('A-start');
    const aEnd = order.indexOf('A-end');
    const bStart = order.indexOf('B-start');
    const bEnd = order.indexOf('B-end');
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThanOrEqual(0);
    // Serialized: later start after earlier end (no overlap)
    expect(Math.max(aStart, bStart)).toBeGreaterThan(Math.min(aEnd, bEnd));
  });

  it('CapitalBroker placeOrder outer lock queues concurrent close', async () => {
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_CONFIRM_FAST = 'true';
    const order: string[] = [];
    const positions = new Map<
      string,
      {
        deal_id: string;
        epic: string;
        direction: 'BUY' | 'SELL';
        size: number;
        open_level: number;
        stop_level?: number | null;
      }
    >();
    const broker = new CapitalBroker({
      credentials: {},
      acquire: async () => ({ ok: true, session: { id: 'lock' }, detail: 'ok' }),
      quote: async (_s, epic) => ({
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        epic,
        raw_ok: true,
      }),
      list: async () => ({ ok: true, positions: [...positions.values()], detail: '' }),
      create: async () => {
        order.push('create');
        return { ok: true, deal_reference: 'ref-lock', detail: 'ok' };
      },
      confirm: async (_s, ref) => {
        order.push('confirm_start');
        await new Promise((r) => setTimeout(r, 40));
        order.push('confirm_end');
        const deal_id = `deal-${ref}`;
        positions.set(deal_id, {
          deal_id,
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: 4410.4,
          stop_level: 4400,
        });
        return { ok: true, deal_id, fill_level: 4410.4, detail: 'ok' };
      },
      modify: async () => ({ ok: true, detail: 'ok' }),
      close: async (_s, id) => {
        order.push('close');
        positions.delete(id);
        return { ok: true, detail: 'closed' };
      },
    });
    await broker.connect();
    const placeP = broker.placeOrder({
      intent_id: 'lock-outer-place',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
    });
    await new Promise((r) => setTimeout(r, 5));
    const closeP = broker.closePosition('deal-ref-lock');
    await Promise.all([placeP, closeP]);
    const iStart = order.indexOf('confirm_start');
    const iEnd = order.indexOf('confirm_end');
    const iClose = order.indexOf('close');
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iEnd).toBeGreaterThan(iStart);
    expect(iClose).toBeGreaterThan(iEnd);
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
