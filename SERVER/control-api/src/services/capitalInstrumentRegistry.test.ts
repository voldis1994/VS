import { describe, expect, it } from 'vitest';
import {
  crossMarketNeedlesResolved,
  epicAliasesForCanonical,
  resolveCapitalInstrument,
  registryRowForEpic,
} from './capitalInstrumentRegistry.js';
import { detectMarketClass } from './marketAssetClass.js';
import { epicToYahooSymbol } from './publicInternetFeeds.js';

describe('Capital instrument registry — epic ↔ name alignment', () => {
  it('US100 / NAS100 / USTEC are the same Nasdaq index', () => {
    for (const epic of ['US100', 'NAS100', 'USTEC']) {
      const r = resolveCapitalInstrument(epic, 'US Tech 100');
      expect(r.canonical).toBe('US100');
      expect(r.asset_class).toBe('index_us');
      expect(r.yahoo_symbol).toBe('^NDX');
      expect(epicToYahooSymbol(epic)).toBe('^NDX');
    }
    const aliases = epicAliasesForCanonical('US100');
    expect(aliases).toContain('NAS100');
    expect(aliases).toContain('USTEC');
  });

  it('ASX Limited share is NOT US100 or AUS200 index', () => {
    const r = resolveCapitalInstrument('ASXAU', 'ASX Limited');
    expect(r.canonical).toBe('ASXLTD');
    expect(r.asset_class).toBe('equity');
    expect(r.yahoo_symbol).toBe('ASX.AX');
    expect(r.identity_ok).toBe(true);
    expect(detectMarketClass('ASXAU', 'ASX Limited')).toBe('equity');
    expect(detectMarketClass('US100', 'US Tech 100')).toBe('index_us');
  });

  it('AUS200 / ASX200 is Australia index — not US100', () => {
    for (const epic of ['AUS200', 'ASX200']) {
      const r = resolveCapitalInstrument(epic, 'Australia 200');
      expect(r.canonical).toBe('AUS200');
      expect(r.yahoo_symbol).toBe('^AXJO');
      expect(r.canonical).not.toBe('US100');
    }
  });

  it('GOLD and XAUUSD map to same canonical', () => {
    expect(resolveCapitalInstrument('GOLD', 'Gold').canonical).toBe('GOLD');
    expect(resolveCapitalInstrument('XAUUSD', 'Gold/USD').canonical).toBe('GOLD');
    expect(registryRowForEpic('XAUUSD')?.yahoo).toBe('GC=F');
  });

  it('US100 cross-market needles include US500 not ASX stock epic', () => {
    const n = crossMarketNeedlesResolved('US100', 'US Tech 100');
    expect(n).toContain('US500');
    expect(n).toContain('NAS100');
    expect(n.some((x) => x === 'ASXAU')).toBe(false);
  });

  it('warns when epic and display name disagree', () => {
    const r = resolveCapitalInstrument('US100', 'ASX Limited');
    expect(r.canonical).toBe('US100');
    expect(r.identity_ok).toBe(false);
    expect(r.identity_note).toMatch(/mismatch|looks like/i);
  });
});
