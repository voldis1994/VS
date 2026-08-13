import { describe, expect, it } from 'vitest';
import {
  buildFresherRefs,
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

  it('buildFresherRefs pulls OHLC + public', () => {
    const refs = buildFresherRefs({
      publicNearMids: [{ name: 'Aurum', mid: 4346 }],
      ohlcClose: 4347,
      formingClose: 4345.5,
    });
    expect(refs).toHaveLength(3);
  });
});
