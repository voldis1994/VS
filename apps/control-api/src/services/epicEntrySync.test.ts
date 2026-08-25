import { describe, expect, it } from 'vitest';
import {
  clearEpicEntrySync,
  EPIC_ENTRY_TTL_MS,
  latestEpicEntry,
  publishEpicEntry,
  readEpicEntry,
} from './epicEntrySync.js';

describe('epicEntrySync', () => {
  it('publishes and peers can read within TTL', () => {
    clearEpicEntrySync();
    const t0 = 1_700_000_000_000;
    publishEpicEntry({
      epic: 'GOLD',
      side: 'BUY',
      regime: 'EXPANSION',
      barBucketMs: t0 - 300_000,
      mid: 4655.5,
      atMs: t0,
      sourceUnitId: 'boss',
    });
    const got = readEpicEntry('gold', t0 + 60_000);
    expect(got).toBeTruthy();
    expect(got!.side).toBe('BUY');
    expect(got!.sourceUnitId).toBe('boss');
    expect(got!.mid).toBe(4655.5);
  });

  it('expires after TTL', () => {
    clearEpicEntrySync();
    const t0 = 1_700_000_000_000;
    publishEpicEntry({
      epic: 'GOLD',
      side: 'SELL',
      regime: 'TREND_DOWN',
      barBucketMs: t0,
      mid: 100,
      atMs: t0,
      sourceUnitId: 'a',
    });
    expect(readEpicEntry('GOLD', t0 + EPIC_ENTRY_TTL_MS + 1)).toBeNull();
    expect(latestEpicEntry('GOLD')).toBeNull();
  });

  it('newer publish replaces older', () => {
    clearEpicEntrySync();
    publishEpicEntry({
      epic: 'GOLD',
      side: 'BUY',
      regime: 'A',
      barBucketMs: 1,
      mid: 1,
      atMs: 100,
      sourceUnitId: 'a',
    });
    publishEpicEntry({
      epic: 'GOLD',
      side: 'SELL',
      regime: 'B',
      barBucketMs: 2,
      mid: 2,
      atMs: 200,
      sourceUnitId: 'b',
    });
    const got = readEpicEntry('GOLD', 250);
    expect(got?.side).toBe('SELL');
    expect(got?.sourceUnitId).toBe('b');
  });
});
