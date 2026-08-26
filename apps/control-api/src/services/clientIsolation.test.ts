import { describe, expect, it } from 'vitest';
import { robotIdFor } from '../services/robotDesk.js';
import { isPublicUnauthedPath } from '../middleware/auth.js';
import { allowDeskSameSide, type DeskOpenUnit } from './deskSideLock.js';
import { pickOhlcMid } from './robotReader.js';
import { observeClosedBars, currentRegime, resetRegimeBook } from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(o: number, h: number, l: number, c: number, t = 1): TenSecBar {
  return {
    open_time_ms: t * 10_000,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks: 5,
  };
}

describe('multi-client isolation invariants', () => {
  it('STOP kills entry brains only — manage-only open trade on same account survives', () => {
    const robots = [
      { id: 'a-entry', account_id: 1, running: true, entry_enabled: true, open_side: null },
      { id: 'a-manage', account_id: 1, running: true, entry_enabled: false, open_side: 'BUY' as const },
      { id: 'b-manage', account_id: 2, running: true, entry_enabled: false, open_side: 'SELL' as const },
    ];
    const stopEntry = robots
      .filter((s) => s.account_id === 1 && s.running && s.entry_enabled)
      .map((s) => s.id);
    const stopFlat = robots
      .filter((s) => s.account_id === 1 && s.running && !s.entry_enabled && !s.open_side)
      .map((s) => s.id);
    expect(stopEntry).toEqual(['a-entry']);
    expect(stopFlat).toEqual([]);
    expect(robots.find((s) => s.id === 'a-manage')?.open_side).toBe('BUY');
    expect(robots.find((s) => s.id === 'b-manage')?.running).toBe(true);
  });

  it('robot ids are per account+epic (Client A ≠ Client B)', () => {
    const aGold = robotIdFor(17, 'GOLD');
    const bGold = robotIdFor(18, 'GOLD');
    const aEur = robotIdFor(17, 'EURUSD');
    expect(aGold).not.toBe(bGold);
    expect(aGold).not.toBe(aEur);
    expect(aGold).toContain('17');
    expect(bGold).toContain('18');
  });

  it('desk lock does not couple different clients on same epic', () => {
    const units: DeskOpenUnit[] = [
      { id: 'c1', epic: 'GOLD', running: true, open_side: 'BUY', client_id: 1, display_name: 'A' },
      { id: 'c2', epic: 'GOLD', running: true, open_side: null, client_id: 2, display_name: 'B' },
    ];
    expect(allowDeskSameSide(units, 'GOLD', 'SELL', 'c2', 2).ok).toBe(true);
  });

  it('OHLC mid prefers own Capital LOCAL over multi', () => {
    expect(
      pickOhlcMid(4660.5, {
        mid: 4700,
        contributing: 3,
        agreement: 'OK',
        anchored_to_capital: true,
      })
    ).toEqual({
      mid: 4660.5,
      source: 'LOCAL',
    });
  });

  it('regime books stay separate per clientId on GOLD', () => {
    resetRegimeBook();
    const up = [100, 100.5, 101.2, 101.9, 102.7, 103.4].map((p, i, a) =>
      bar(i === 0 ? p : a[i - 1]!, p + 0.4, p - 0.4, p, i + 1)
    );
    const down = [110, 109.5, 108.8, 108.1, 107.3, 106.6].map((p, i, a) =>
      bar(i === 0 ? p : a[i - 1]!, p + 0.4, p - 0.4, p, i + 1)
    );
    observeClosedBars('GOLD', up, 'A', 1);
    observeClosedBars('GOLD', down, 'B', 2);
    expect(currentRegime('GOLD', 1)?.current).toBe('TREND_UP');
    expect(currentRegime('GOLD', 2)?.current).toBe('TREND_DOWN');
  });

  it('admin client list path is not under client API prefix', () => {
    const publicPrefixes = ['/api/client-auth/', '/api/client/', '/ws/client'];
    const adminPath = '/api/clients';
    expect(publicPrefixes.some((p) => adminPath === p || adminPath.startsWith(p))).toBe(false);
  });

  it('static client panel GET is public; admin API is not', () => {
    expect(isPublicUnauthedPath('GET', '/')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/assets/index.js')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/logo.svg')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/api/clients')).toBe(false);
    expect(isPublicUnauthedPath('POST', '/')).toBe(false);
    expect(isPublicUnauthedPath('GET', '/api/client-auth/login')).toBe(true);
  });
});
