import { describe, expect, it, vi } from 'vitest';
import { CapitalBroker } from '../broker.js';

describe('CapitalBroker market_status cache (stream path)', () => {
  function makeBroker(quoteImpl: (epic: string) => Promise<any>) {
    const broker = new CapitalBroker({
      credentials: {
        environment: 'demo',
        apiKey: 'k',
        identifier: 'i',
        password: 'p',
        connectionId: 900001,
      },
      acquire: async () => ({
        ok: true,
        session: { id: 's' },
        detail: 'ok',
      }),
      quote: async (_s, epic) => quoteImpl(epic),
      list: async () => ({ ok: true, positions: [] }),
      create: async () => ({ ok: false, detail: 'no' }),
      close: async () => ({ ok: false, detail: 'no' }),
    });
    return broker;
  }

  it('REST quote caches market_status for later stream ticks', async () => {
    const broker = makeBroker(async () => ({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      epic: 'GOLD',
      market_status: 'TRADEABLE',
      min_stop_distance: 0.3,
    }));
    // Force session present
    (broker as any).session = { id: 's' };
    const rest = await broker.getQuote('GOLD');
    expect(rest?.market_status).toBe('TRADEABLE');
    expect(broker.cachedMarketStatus('GOLD')).toBe('TRADEABLE');

    // Simulate healthy stream — must not wipe status to null
    const stream = (broker as any).stream;
    stream.getLatest = () => ({
      epic: 'GOLD',
      bid: 4401,
      offer: 4401.3,
      mid: 4401.15,
      ts_ms: Date.now(),
    });
    stream.isHealthy = () => true;
    stream.ensure = () => {};

    const streamed = await broker.getQuote('GOLD');
    expect(streamed?.mid).toBeCloseTo(4401.15, 5);
    expect(streamed?.market_status).toBe('TRADEABLE');
  });

  it('CLOSED cache forces REST path instead of stream-only ticks', async () => {
    let restCalls = 0;
    const broker = makeBroker(async () => {
      restCalls += 1;
      return {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        epic: 'GOLD',
        market_status: restCalls === 1 ? 'CLOSED' : 'TRADEABLE',
      };
    });
    (broker as any).session = { id: 's' };
    await broker.getQuote('GOLD');
    expect(broker.cachedMarketStatus('GOLD')).toBe('CLOSED');

    const stream = (broker as any).stream;
    stream.getLatest = () => ({
      epic: 'GOLD',
      bid: 4401,
      offer: 4401.3,
      mid: 4401.15,
      ts_ms: Date.now(),
    });
    stream.isHealthy = () => true;
    stream.ensure = () => {};

    const q = await broker.getQuote('GOLD');
    // Forced REST — second call returns TRADEABLE and updates cache
    expect(restCalls).toBe(2);
    expect(q?.market_status).toBe('TRADEABLE');
  });

  it('awaits first REST marketStatus before stream-only return', async () => {
    let restCalls = 0;
    const broker = makeBroker(async () => {
      restCalls += 1;
      return {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        epic: 'GOLD',
        market_status: 'CLOSED',
      };
    });
    (broker as any).session = { id: 's' };

    const stream = (broker as any).stream;
    stream.getLatest = () => ({
      epic: 'GOLD',
      bid: 4401,
      offer: 4401.3,
      mid: 4401.15,
      ts_ms: Date.now(),
    });
    stream.isHealthy = () => true;
    stream.ensure = () => {};

    const q = await broker.getQuote('GOLD');
    expect(restCalls).toBeGreaterThanOrEqual(1);
    expect(broker.cachedMarketStatus('GOLD')).toBe('CLOSED');
    expect(q?.market_status).toBe('CLOSED');
    expect(q?.mid).toBeCloseTo(4400.2, 5);
  });

  it('maps XAUUSD → GOLD before REST quote', async () => {
    let seenEpic = '';
    const broker = makeBroker(async (epic) => {
      seenEpic = epic;
      return {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        epic: 'GOLD',
        market_status: 'TRADEABLE',
      };
    });
    (broker as any).session = { id: 's' };
    const q = await broker.getQuote('XAUUSD');
    expect(seenEpic).toBe('GOLD');
    expect(q?.epic).toBe('GOLD');
  });
});
