import { describe, expect, it } from 'vitest';
import { routeIntentToSubscriptions } from './intentFanout.js';
import { formatTradeLabel, formatTradeSide } from './tradePresentation.js';

describe('intent fan-out routing isolation', () => {
  const subs = [
    { client_id: 1, epic: 'GOLD', running: true, lot_size: 0.1 },
    { client_id: 2, epic: 'EURUSD', running: true, lot_size: 0.05 },
    { client_id: 3, epic: 'GOLD', running: true, lot_size: 0.2 },
    { client_id: 4, epic: 'GOLD', running: false, lot_size: 0.3 },
  ];

  it('XAUUSD/GOLD decision only hits RUNNING GOLD subscribers with own lots', () => {
    const matched = routeIntentToSubscriptions('GOLD', subs);
    expect(matched.map((m) => m.client_id).sort()).toEqual([1, 3]);
    expect(matched.find((m) => m.client_id === 1)?.lot_size).toBe(0.1);
    expect(matched.find((m) => m.client_id === 3)?.lot_size).toBe(0.2);
    expect(matched.some((m) => m.client_id === 2)).toBe(false);
    expect(matched.some((m) => m.client_id === 4)).toBe(false);
  });

  it('EURUSD decision does not hit GOLD clients', () => {
    const matched = routeIntentToSubscriptions('EURUSD', subs);
    expect(matched).toEqual([{ client_id: 2, lot_size: 0.05 }]);
  });

  it('STOP equivalent: non-running client excluded', () => {
    const afterStop = subs.map((s) =>
      s.client_id === 1 ? { ...s, running: false } : s
    );
    const matched = routeIntentToSubscriptions('GOLD', afterStop);
    expect(matched.map((m) => m.client_id)).toEqual([3]);
  });
});

describe('honest trade labels', () => {
  it('shows BUY/SELL only — never invents LONG/SCALP from direction', () => {
    expect(formatTradeSide('BUY')).toBe('BUY');
    expect(formatTradeSide('SELL')).toBe('SELL');
    expect(formatTradeLabel('BUY')).toBe('BUY');
    expect(formatTradeLabel('SELL')).toBe('SELL');
    expect(formatTradeLabel('BUY')).not.toMatch(/LONG/);
    expect(formatTradeLabel('SELL')).not.toMatch(/SCALP/);
  });

  it('appends real setup_type from pipeline when present', () => {
    expect(formatTradeLabel('BUY', 'CONTINUATION')).toBe('BUY · CONTINUATION');
    expect(formatTradeLabel('SELL', 'PULLBACK')).toBe('SELL · PULLBACK');
  });
});
