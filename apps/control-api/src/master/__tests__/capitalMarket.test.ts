import { describe, expect, it } from 'vitest';
import { capitalApiEpic, normalizeEpicKey } from '../broker.js';
import { capitalMarketAllowsTrading } from '../capitalMarket.js';

describe('capitalApiEpic', () => {
  it('maps MT4-style XAUUSD to Capital GOLD', () => {
    expect(capitalApiEpic('XAUUSD')).toBe('GOLD');
    expect(capitalApiEpic('xau')).toBe('GOLD');
    expect(capitalApiEpic('GOLD')).toBe('GOLD');
  });

  it('maps silver aliases', () => {
    expect(capitalApiEpic('XAGUSD')).toBe('SILVER');
    expect(capitalApiEpic('SILVER')).toBe('SILVER');
  });

  it('keeps other epics uppercased', () => {
    expect(capitalApiEpic('US100')).toBe('US100');
  });

  it('normalizeEpicKey still unifies gold family for sync', () => {
    expect(normalizeEpicKey('GOLD')).toBe(normalizeEpicKey('XAUUSD'));
  });
});

describe('capitalMarketAllowsTrading', () => {
  it('fails closed on missing/unknown status', () => {
    expect(capitalMarketAllowsTrading(null)).toBe(false);
    expect(capitalMarketAllowsTrading(undefined)).toBe(false);
    expect(capitalMarketAllowsTrading('')).toBe(false);
  });

  it('allows TRADEABLE and OPEN', () => {
    expect(capitalMarketAllowsTrading('TRADEABLE')).toBe(true);
    expect(capitalMarketAllowsTrading('open')).toBe(true);
  });

  it('blocks CLOSED / AUCTION / etc', () => {
    expect(capitalMarketAllowsTrading('CLOSED')).toBe(false);
    expect(capitalMarketAllowsTrading('AUCTION')).toBe(false);
    expect(capitalMarketAllowsTrading('OFFLINE')).toBe(false);
  });
});
