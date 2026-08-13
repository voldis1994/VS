import { describe, expect, it } from 'vitest';
import {
  epicToCoinbaseProduct,
  epicToMetalKey,
  epicToYahooSymbol,
  fusePriceMids,
} from './publicInternetFeeds.js';

describe('public internet epic mapping', () => {
  it('maps gold / silver Capitals to Yahoo futures', () => {
    expect(epicToYahooSymbol('GOLD')).toBe('GC=F');
    expect(epicToYahooSymbol('XAUUSD')).toBe('GC=F');
    expect(epicToYahooSymbol('SILVER')).toBe('SI=F');
    expect(epicToMetalKey('GOLD')).toBe('gold');
    expect(epicToMetalKey('XAGUSD')).toBe('silver');
  });

  it('maps FX and crypto', () => {
    expect(epicToYahooSymbol('EURUSD')).toBe('EURUSD=X');
    expect(epicToYahooSymbol('BTCUSD')).toBe('BTC-USD');
    expect(epicToCoinbaseProduct('BTCUSD')).toBe('BTC-USD');
  });
});

describe('fusePriceMids', () => {
  it('medians and drops outliers', () => {
    const f = fusePriceMids([100, 100.1, 100.05, 140], { mixedPublic: true });
    expect(f.contributing).toBe(3);
    expect(f.mid).toBeGreaterThan(99);
    expect(f.mid).toBeLessThan(101);
    expect(f.agreement).not.toBe('NONE');
  });

  it('marks single mid insufficient', () => {
    expect(fusePriceMids([42]).agreement).toBe('INSUFFICIENT');
  });
});
