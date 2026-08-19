import { describe, expect, it } from 'vitest';
import {
  PUBLIC_SENDERS,
  epicToBinanceUsSymbol,
  epicToBitstampPair,
  epicToCoinGeckoId,
  epicToCoinbaseProduct,
  epicToFawazMetal,
  epicToGoldApiSymbol,
  epicToKrakenPair,
  epicToKucoinSymbol,
  epicToMetalKey,
  epicToYahooSymbol,
  fusePriceMids,
  isGoldEpic,
  publicFeedNotApplicable,
  publicFeedsApplicable,
} from './publicInternetFeeds.js';

describe('public internet epic mapping', () => {
  it('maps gold / silver Capitals to Yahoo futures', () => {
    expect(epicToYahooSymbol('GOLD')).toBe('GC=F');
    expect(epicToYahooSymbol('XAUUSD')).toBe('GC=F');
    expect(epicToYahooSymbol('SILVER')).toBe('SI=F');
    expect(epicToMetalKey('GOLD')).toBe('gold');
    expect(epicToMetalKey('XAGUSD')).toBe('silver');
  });

  it('maps GOLD onto several live public spots (not FX-only IDLE)', () => {
    expect(epicToGoldApiSymbol('GOLD')).toBe('XAU');
    expect(epicToFawazMetal('GOLD')).toBe('xau');
    expect(epicToCoinbaseProduct('GOLD')).toBe('PAXG-USD');
    expect(epicToKrakenPair('GOLD')).toBe('PAXGUSD');
    expect(epicToKucoinSymbol('GOLD')).toBe('PAXG-USDT');
    expect(epicToBinanceUsSymbol('GOLD')).toBe('PAXGUSDT');
    expect(epicToCoinGeckoId('GOLD')).toBe('pax-gold');
    expect(epicToBitstampPair('GOLD')).toBe('paxgusd');
    expect(PUBLIC_SENDERS.length).toBeGreaterThanOrEqual(10);
  });

  it('treats N/A mapping details as not-applicable, not errors', () => {
    expect(publicFeedNotApplicable('N/A · Coinbase has no mapping for this epic')).toBe(true);
    expect(publicFeedNotApplicable('Coinbase HTTP 503')).toBe(false);
  });

  it('maps FX and crypto', () => {
    expect(epicToYahooSymbol('EURUSD')).toBe('EURUSD=X');
    expect(epicToYahooSymbol('BTCUSD')).toBe('BTC-USD');
    expect(epicToCoinbaseProduct('BTCUSD')).toBe('BTC-USD');
    expect(epicToBitstampPair('EURUSD')).toBe('eurusd');
    expect(epicToBitstampPair('USDJPY')).toBe('usdjpy');
    expect(epicToKrakenPair('GBPUSD')).toBe('GBPUSD');
  });

  it('maps indices and energy for major markets', () => {
    expect(epicToYahooSymbol('US500')).toBe('^GSPC');
    expect(epicToYahooSymbol('US100')).toBe('^NDX');
    expect(epicToYahooSymbol('GER40')).toBe('^GDAXI');
    expect(epicToYahooSymbol('JP225')).toBe('^N225');
    expect(epicToYahooSymbol('USOIL')).toBe('CL=F');
    expect(epicToYahooSymbol('UKOIL')).toBe('BZ=F');
    expect(epicToYahooSymbol('NATURALGAS')).toBe('NG=F');
    expect(publicFeedsApplicable('US500')).toBe(true);
    expect(publicFeedsApplicable('EURUSD')).toBe(true);
    expect(publicFeedsApplicable('SILVER')).toBe(true);
    expect(publicFeedsApplicable('BTCUSD')).toBe(true);
  });

  it('maps ASX Ltd stock epic without false gold match', () => {
    expect(isGoldEpic('ASXAU')).toBe(false);
    expect(isGoldEpic('XAUUSD')).toBe(true);
    expect(isGoldEpic('GOLD')).toBe(true);
    expect(epicToYahooSymbol('ASXAU')).toBe('ASX.AX');
    expect(epicToCoinbaseProduct('ASXAU')).toBeNull();
  });

  it('silver gets metal feeds but not crypto token venues', () => {
    expect(epicToYahooSymbol('SILVER')).toBe('SI=F');
    expect(epicToGoldApiSymbol('SILVER')).toBe('XAG');
    expect(epicToCoinbaseProduct('SILVER')).toBeNull();
    expect(publicFeedsApplicable('SILVER')).toBe(true);
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
