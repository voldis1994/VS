import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildFresherRefs,
  detectCapitalIsolatedExtreme,
  detectStaleQuoteAdverse,
} from './staleQuoteGuard.js';
import { analysisMid } from './analysisPrice.js';
import { allowEntryFromDataQuality } from './dataQuality.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('detectStaleQuoteAdverse', () => {
  it('blocks BUY when fresher price already dropped', () => {
    const v = detectStaleQuoteAdverse('BUY', 4354.11, [
      { label: '10s OHLC close', mid: 4346.0 },
      { label: 'Yahoo', mid: 4345.5 },
    ]);
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/STALE CAPITAL/);
    expect(v.rel).toBeLessThan(-0.001);
  });

  it('allows BUY when refs agree with Capital', () => {
    const v = detectStaleQuoteAdverse('BUY', 4354.0, [
      { label: '10s OHLC close', mid: 4353.7 },
      { label: 'Yahoo', mid: 4354.2 },
    ]);
    expect(v.block).toBe(false);
  });

  it('blocks SELL when fresher price already rallied', () => {
    const v = detectStaleQuoteAdverse('SELL', 4350.0, [
      { label: '10s forming', mid: 4358.0 },
    ]);
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/STALE CAPITAL/);
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

describe('STALE GUARD · Capital primary (no mandatory cross-feed)', () => {
  it('Capital mid valid + no fresher refs → ALLOW (cross-feed optional)', () => {
    const v = detectStaleQuoteAdverse('BUY', 2650.5, []);
    expect(v.block).toBe(false);
    expect(v.reason).toMatch(/Capital primary|continue/i);
    expect(v.reason).not.toMatch(/confirmation required/i);
  });

  it('Capital mid valid + empty public refs → SELL also ALLOW', () => {
    const v = detectStaleQuoteAdverse('SELL', 1.08542, []);
    expect(v.block).toBe(false);
    expect(v.capital_mid).toBe(1.08542);
  });

  it('Capital mid UNKNOWN → NO ENTRY (Capital itself invalid)', () => {
    expect(detectStaleQuoteAdverse('BUY', null, []).block).toBe(true);
    expect(detectStaleQuoteAdverse('SELL', Number.NaN, [{ label: 'Yahoo', mid: 100 }]).block).toBe(
      true
    );
  });

  it('requireRefs:true still blocks when no refs (opt-in legacy)', () => {
    const v = detectStaleQuoteAdverse('BUY', 100, [], { requireRefs: true });
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/confirmation required/);
  });

  it('fresh Capital BID+ASK mid passes data quality without public refs', () => {
    const now = Date.now();
    const mid = analysisMid({ bid: 2649.8, ask: 2650.2 });
    expect(mid).not.toBeNull();
    const dq = allowEntryFromDataQuality(
      { mid: mid!, fetch_ms: now, source_ms: now - 200 },
      { nowMs: now, maxStaleMs: 15_000 }
    );
    expect(dq.ok).toBe(true);
    const stale = detectStaleQuoteAdverse('BUY', mid, []);
    expect(stale.block).toBe(false);
  });

  it('stale Capital fetch age → NO ENTRY via data quality (not cross-feed)', () => {
    const now = Date.now();
    const mid = analysisMid({ bid: 100, ask: 100.02 });
    expect(mid).not.toBeNull();
    const dq = allowEntryFromDataQuality(
      { mid: mid!, fetch_ms: now - 60_000 },
      { nowMs: now, maxStaleMs: 15_000 }
    );
    expect(dq.ok).toBe(false);
    expect(dq.reason).toMatch(/STALE/i);
  });

  it('LIVE desk passes requireRefs:false (Capital primary source contract)', () => {
    const desk = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(desk).toMatch(/detectStaleQuoteAdverse\(/);
    expect(desk).toMatch(/requireRefs:\s*false/);
  });
});

describe('detectCapitalIsolatedExtreme', () => {
  it('allows when no public-near (do not miss Capital-only moves)', () => {
    const v = detectCapitalIsolatedExtreme('BUY', 4519, []);
    expect(v.block).toBe(false);
    expect(v.reason).toMatch(/Capital-only allowed/);
  });

  it('blocks BUY on Capital fake dump vs public', () => {
    const v = detectCapitalIsolatedExtreme('BUY', 4500, [4510, 4512, 4509]);
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/FAKE DIP/);
  });

  it('blocks SELL on Capital fake spike vs public', () => {
    const v = detectCapitalIsolatedExtreme('SELL', 4525, [4510, 4511]);
    expect(v.block).toBe(true);
    expect(v.reason).toMatch(/FAKE SPIKE/);
  });

  it('allows when Capital aligns with public', () => {
    const v = detectCapitalIsolatedExtreme('BUY', 4510.5, [4510, 4511, 4509.5]);
    expect(v.block).toBe(false);
  });
});
