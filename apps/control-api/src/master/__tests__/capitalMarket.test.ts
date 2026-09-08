import { describe, expect, it } from 'vitest';
import { capitalMarketAllowsTrading } from '../capitalMarket.js';

describe('capitalMarketAllowsTrading', () => {
  it('allows missing/empty status (Capital often omits)', () => {
    expect(capitalMarketAllowsTrading(null)).toBe(true);
    expect(capitalMarketAllowsTrading(undefined)).toBe(true);
    expect(capitalMarketAllowsTrading('')).toBe(true);
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
