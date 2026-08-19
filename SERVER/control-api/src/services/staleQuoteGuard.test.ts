import { describe, expect, it } from 'vitest';
import {
  buildFresherRefs,
  detectCapitalLagLead,
  detectStaleQuoteAdverse,
} from './staleQuoteGuard.js';

describe('detectStaleQuoteAdverse', () => {
  it('blocks BUY when fresher price already dropped under Capital ask', () => {
    // Screenshot case: buttons ~4354, chart already ~4346
    const v = detectStaleQuoteAdverse('BUY', 4354.11, [
      { label: '10s OHLC close', mid: 4346.0 },
      { label: 'Yahoo', mid: 4345.5 },
    ]);
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/BUY blocked/);
    expect(v.rel).toBeLessThan(-0.001);
  });

  it('allows BUY when refs agree with Capital', () => {
    const v = detectStaleQuoteAdverse('BUY', 4354.0, [
      { label: '10s OHLC close', mid: 4353.7 },
      { label: 'Yahoo', mid: 4354.2 },
    ]);
    expect(v.block).toBe(false);
  });

  it('blocks SELL when fresher price already rallied above Capital', () => {
    const v = detectStaleQuoteAdverse('SELL', 4350.0, [
      { label: '10s forming', mid: 4358.0 },
    ]);
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/SELL blocked/);
  });

  it('does not block SELL when Yahoo/Aurum sit on a structural Gold basis (~1.3%)', () => {
    // Live board: Capital ~4378, Yahoo ~4435 — must not veto every with-trend SELL
    const v = detectStaleQuoteAdverse('SELL', 4377.95, [
      { label: 'Yahoo Finance (public)', mid: 4435 },
      { label: 'Aurum metals spot (public)', mid: 4434.5 },
      { label: '10s OHLC close', mid: 4378.07 },
    ]);
    expect(v.block).toBe(false);
  });

  it('buildFresherRefs pulls OHLC + public', () => {
    const refs = buildFresherRefs({
      publicNearMids: [{ name: 'Aurum', mid: 4346 }],
      ohlcClose: 4347,
      formingClose: 4345.5,
    });
    expect(refs).toHaveLength(3);
  });
});

describe('detectCapitalLagLead', () => {
  const dumped = [
    { label: 'Coinbase spot (public)', mid: 4346.2 },
    { label: 'Kraken spot (public)', mid: 4345.9 },
    { label: 'Bitstamp (public)', mid: 4346.0 },
  ];
  const rallied = [
    { label: 'Coinbase spot (public)', mid: 4354.4 },
    { label: 'Kraken spot (public)', mid: 4354.1 },
    { label: 'Bitstamp (public)', mid: 4353.9 },
  ];

  it('SELLs on Capital when other feeds already dumped', () => {
    const v = detectCapitalLagLead(4354.11, dumped);
    expect(v.hit).toBe(true);
    expect(v.direction).toBe('SELL');
    expect(v.reason).toMatch(/LAG CAPITAL · SELL/);
  });

  it('BUYs on Capital when other feeds already rallied', () => {
    const v = detectCapitalLagLead(4346.0, rallied);
    expect(v.hit).toBe(true);
    expect(v.direction).toBe('BUY');
    expect(v.reason).toMatch(/LAG CAPITAL · BUY/);
  });

  it('does not trade a single noisy feed', () => {
    const v = detectCapitalLagLead(4354.0, [{ label: 'Coinbase spot (public)', mid: 4346.0 }]);
    expect(v.hit).toBe(false);
    expect(v.direction).toBeNull();
  });

  it('ignores Yahoo/Aurum Gold basis (~1.3%) as lag', () => {
    const v = detectCapitalLagLead(4377.95, [
      { label: 'Yahoo Finance (public)', mid: 4435 },
      { label: 'Aurum metals spot (public)', mid: 4434.5 },
      { label: '10s OHLC close', mid: 4378.07 },
    ]);
    expect(v.hit).toBe(false);
  });

  it('does not fire when feeds agree with Capital', () => {
    const v = detectCapitalLagLead(4354.0, [
      { label: 'Coinbase spot (public)', mid: 4353.8 },
      { label: 'Kraken spot (public)', mid: 4354.2 },
      { label: 'Bitstamp (public)', mid: 4354.0 },
    ]);
    expect(v.hit).toBe(false);
  });

  it('needs a majority — split up/down is not a lead', () => {
    const v = detectCapitalLagLead(4350.0, [
      { label: 'Coinbase spot (public)', mid: 4358.0 },
      { label: 'Kraken spot (public)', mid: 4357.5 },
      { label: 'Bitstamp (public)', mid: 4342.0 },
      { label: 'KuCoin spot (public)', mid: 4341.8 },
    ]);
    expect(v.hit).toBe(false);
  });

  it('live board: Yahoo 50pts is basis; Coinbase cluster vs Capital still SELLs', () => {
    // 02:07 board: Capital 4338.31, Yahoo/Aurum/Fawaz ~4390–4402, CoinGecko/Binance outliers
    const v = detectCapitalLagLead(4338.31, [
      { label: 'Yahoo Finance (public)', mid: 4391.5 },
      { label: 'Aurum metals spot (public)', mid: 4393.8 },
      { label: 'Gold-API spot (public)', mid: 4337.6 },
      { label: 'Fawaz FX / XAU (public)', mid: 4402.33 },
      { label: 'Coinbase spot (public)', mid: 4334.98 },
      { label: 'Kraken spot (public)', mid: 4333.93 },
      { label: 'KuCoin spot (public)', mid: 4339 },
      { label: 'Binance.US (public)', mid: 4350 },
      { label: 'CoinGecko (public)', mid: 4329.03 },
      { label: 'Bitstamp (public)', mid: 4334.88 },
    ]);
    expect(v.hit).toBe(true);
    expect(v.direction).toBe('SELL');
  });

  it('one CoinGecko dump does not veto BUY when the cluster still agrees', () => {
    const v = detectStaleQuoteAdverse('BUY', 4338.31, [
      { label: 'Gold-API spot (public)', mid: 4337.6 },
      { label: 'Coinbase spot (public)', mid: 4337.9 },
      { label: 'Kraken spot (public)', mid: 4338.0 },
      { label: 'KuCoin spot (public)', mid: 4338.2 },
      { label: 'Binance.US (public)', mid: 4338.4 },
      { label: 'CoinGecko (public)', mid: 4329.03 },
      { label: 'Bitstamp (public)', mid: 4337.8 },
    ]);
    expect(v.block).toBe(false);
  });

  it('Capital.com LIVE 8pts above stale quote.mid is a BUY lag, not ignored', () => {
    const v = detectCapitalLagLead(4330.35, [
      { label: 'BOOS / Capital.com LIVE', mid: 4338.08 },
      { label: 'Gold-API spot (public)', mid: 4338.9 },
      { label: 'Binance.US (public)', mid: 4330.27 },
    ]);
    expect(v.hit).toBe(true);
    expect(v.direction).toBe('BUY');
  });

  it('public dump still SELLs even when a Capital.com leg sits on the quote', () => {
    const v = detectCapitalLagLead(4354.11, [
      { label: 'Capital.com GOLD', mid: 4354.11 },
      ...dumped,
    ]);
    expect(v.direction).toBe('SELL');
  });
});
