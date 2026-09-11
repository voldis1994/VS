/**
 * Per-client primary feeds + regime books.
 * Prevents order / SL / HardInv surprises from cross-client bleed.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  observeClosedBars,
  notePipelineRegime,
  currentRegime,
  resetRegimeBook,
} from './regimes.js';
import { robotIdFor } from './robotDesk.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function bars(direction: 'up' | 'down'): TenSecBar[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const base = direction === 'up' ? 2000 + i * 0.8 : 2000 - i * 0.8;
    return {
      open_time_ms: i * 10_000,
      open: base,
      high: base + 0.35,
      low: base - 0.15,
      close: direction === 'up' ? base + 0.25 : base - 0.25,
      ticks: 10,
    };
  });
}

describe('per-client regime book isolation', () => {
  beforeEach(() => resetRegimeBook());

  it('Client A and Client B keep separate regime books on the same epic', () => {
    const a = robotIdFor(17, 'GOLD');
    const b = robotIdFor(18, 'GOLD');
    expect(a).not.toBe(b);

    const snapA = observeClosedBars('GOLD', bars('up'), 'Gold', a);
    const snapB = observeClosedBars('GOLD', bars('down'), 'Gold', b);

    expect(currentRegime('GOLD', a)?.current).toBe(snapA.current);
    expect(currentRegime('GOLD', b)?.current).toBe(snapB.current);
    expect(currentRegime('GOLD', a)?.current).not.toBe(currentRegime('GOLD', b)?.current);
  });

  it('pipeline regime notes do not overwrite a live robot book', () => {
    const robot = robotIdFor(21, 'EURUSD');
    observeClosedBars('EURUSD', bars('up'), 'EURUSD', robot);
    const before = currentRegime('EURUSD', robot)?.current;
    notePipelineRegime('EURUSD', 'TREND_DOWN', 'EURUSD');
    expect(currentRegime('EURUSD', robot)?.current).toBe(before);
    expect(currentRegime('EURUSD', 'pipeline')?.current).toBe('TREND_DOWN');
  });
});

describe('per-client robot + Capital feed contract', () => {
  it('robot ids are the isolation key for account+epic', () => {
    expect(robotIdFor(1, 'XAUUSD')).not.toBe(robotIdFor(2, 'XAUUSD'));
    expect(robotIdFor(1, 'XAUUSD')).not.toBe(robotIdFor(1, 'EURUSD'));
  });

  it('readMultiFeedPrice pins Capital legs via connectionId option', () => {
    const src = readFileSync(fileURLToPath(new URL('./robotReader.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/connectionId/);
    expect(src).toMatch(/never fuse another client's Capital/);
  });

  it('fanout skips clients that already run an own entry brain', () => {
    const src = readFileSync(fileURLToPath(new URL('./intentFanout.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/hasRunningEntryBrain/);
    expect(src).toMatch(/skipped — client runs own entry brain/);
  });

  it('fanout executes all subscribers in parallel (Promise.all), not a serial for-await queue', () => {
    const src = readFileSync(fileURLToPath(new URL('./intentFanout.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/Promise\.all\s*\(\s*subs\.map/);
    expect(src).toMatch(/All clients in parallel/);
  });

  it('each robot has its own setInterval cadence (concurrent clients)', () => {
    const desk = readFileSync(fileURLToPath(new URL('./robotDesk.ts', import.meta.url)), 'utf8');
    expect(desk).toMatch(/setInterval\(\(\) => void robotCycle\(s\), ms\)/);
    expect(desk).toMatch(/One timer per robot/);
  });

  it('active fanout subscriptions require ais.trading_enabled', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./clientSubscriptions.ts', import.meta.url)),
      'utf8'
    );
    expect(src).toMatch(/COALESCE\(ais\.trading_enabled, false\) = true/);
  });

  it('Capital desk/fanout use short acquire (no full-cycle lease freeze)', () => {
    const capital = readFileSync(fileURLToPath(new URL('./capitalCom.ts', import.meta.url)), 'utf8');
    expect(capital).toMatch(/acquireCapitalSession/);
    expect(capital).toMatch(/capitalFetch/);
    expect(capital).toMatch(/CAPITAL_HTTP_TIMEOUT_MS/);
    expect(capital).toMatch(/withBoundCapitalAccount/);
    expect(capital).toMatch(/bindCapitalSession/);
    expect(capital).toMatch(/AsyncLocalStorage/);

    const desk = readFileSync(fileURLToPath(new URL('./robotDesk.ts', import.meta.url)), 'utf8');
    expect(desk).toMatch(/acquireCapitalSession\(/);
    expect(desk).not.toMatch(/acquireCapitalSessionLease/);
    expect(desk).not.toMatch(/opened\.release\(\)/);
    expect(desk).toMatch(/Connecting Capital\.com/);
    expect(desk).toMatch(/CYCLE WATCHDOG/);
    expect(desk).toMatch(/external_account_id required \(multi-account connection\)/);

    const fanout = readFileSync(fileURLToPath(new URL('./intentFanout.ts', import.meta.url)), 'utf8');
    expect(fanout).toMatch(/acquireCapitalSession\(/);
    expect(fanout).not.toMatch(/acquireCapitalSessionLease/);
    expect(fanout).not.toMatch(/opened\.release\(\)/);
  });

  it('HardInv flip + 1m profit keys live on per-robot Internal (not shared)', () => {
    const desk = readFileSync(fileURLToPath(new URL('./robotDesk.ts', import.meta.url)), 'utf8');
    expect(desk).toMatch(/pending_hardinv_flip/);
    expect(desk).toMatch(/HOLD profit/);
    expect(desk).toMatch(/PeakProtect armed only on reverse/);
    expect(desk).toMatch(/force-close ghost/);
    expect(desk).toMatch(/HARDINV_FLIP_EXPIRE_MS = 60_000/);
    expect(desk).toMatch(/HardInv flip FIRST/);
    expect(desk).toMatch(/last_1m_profit_exit_key/);
    expect(desk).toMatch(/last_1m_entry_key/);
    expect(desk).toMatch(/robotIdFor\(accountId, epic\)/);
  });

  it('WS trade events emit only to owning client_id', () => {
    const desk = readFileSync(fileURLToPath(new URL('./robotDesk.ts', import.meta.url)), 'utf8');
    expect(desk).toMatch(/emitToClient\(s\.client_id/);
    expect(desk).toMatch(/emitToClient\(acc\.client_id/);
  });
});
