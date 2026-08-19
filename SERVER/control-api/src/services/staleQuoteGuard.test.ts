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

  it('ignores Capital-named legs so they cannot cancel a public lead', () => {
    const v = detectCapitalLagLead(4354.11, [
      { label: 'Capital.com GOLD', mid: 4354.11 },
      ...dumped,
    ]);
    expect(v.direction).toBe('SELL');
  });
});
