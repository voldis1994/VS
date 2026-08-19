import { describe, expect, it } from 'vitest';
import {
  crossMarketNeedles,
  crossMarketNeedlesForClass,
  detectMarketClass,
} from './marketAssetClass.js';

describe('marketAssetClass', () => {
  it('detects major asset classes from Capital epics', () => {
    expect(detectMarketClass('GOLD', 'Gold')).toBe('gold');
    expect(detectMarketClass('XAGUSD', 'Silver')).toBe('silver');
    expect(detectMarketClass('USOIL', 'WTI Oil')).toBe('oil_wti');
    expect(detectMarketClass('UKOIL', 'Brent')).toBe('oil_brent');
    expect(detectMarketClass('NATURALGAS', 'Natural Gas')).toBe('natgas');
    expect(detectMarketClass('EURUSD')).toBe('fx');
    expect(detectMarketClass('US500', 'S&P 500')).toBe('index_us');
    expect(detectMarketClass('GER40', 'DAX')).toBe('index_eu');
    expect(detectMarketClass('JP225', 'Nikkei')).toBe('index_asia');
    expect(detectMarketClass('BTCUSD', 'Bitcoin')).toBe('crypto');
  });

  it('returns cross-market needles for every major class', () => {
    for (const cls of [
      'gold',
      'silver',
      'oil_wti',
      'fx',
      'index_us',
      'index_eu',
      'crypto',
    ] as const) {
      expect(crossMarketNeedlesForClass(cls).length).toBeGreaterThan(3);
    }
  });

  it('EURUSD needles include indices and gold — not self', () => {
    const n = crossMarketNeedles('EURUSD', 'EUR/USD');
    expect(n.join(' ')).toMatch(/US500|NAS/);
    expect(n.join(' ')).toMatch(/XAU|GOLD/);
    expect(n).not.toContain('EURUSD');
  });

  it('US500 needles include FX and gold', () => {
    const n = crossMarketNeedles('US500', 'S&P 500');
    expect(n.join(' ')).toMatch(/EURUSD|USDJPY/);
    expect(n.join(' ')).toMatch(/XAU|GOLD/);
  });

  it('BTC needles include ETH and indices', () => {
    const n = crossMarketNeedles('BTCUSD', 'Bitcoin');
    expect(n.join(' ')).toMatch(/ETH|US500|NAS/);
  });
});
