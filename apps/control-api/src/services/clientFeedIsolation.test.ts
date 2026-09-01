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
  const warm: TenSecBar[] = [];
  let p = 2000;
  for (let i = 0; i < 140; i++) {
    const c = p + Math.sin(i / 7) * 0.05;
    warm.push({
      open_time_ms: i * 10_000,
      open: p,
      high: c + 0.08,
      low: c - 0.08,
      close: c,
      ticks: 10,
    });
    p = c;
  }
  const tail = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35].map(
    (i) => {
      const step = direction === 'up' ? 0.55 : -0.55;
      const base = 2000 + (direction === 'up' ? i * step : i * step);
      const open = i === 0 ? 2000 : base - step;
      const close = base;
      return {
        open_time_ms: (140 + i) * 10_000,
        open,
        high: Math.max(open, close) + 0.35,
        low: Math.min(open, close) - 0.15,
        close,
        ticks: 10,
      };
    }
  );
  return [...warm, ...tail];
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

  it('active fanout subscriptions require ais.trading_enabled', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./clientSubscriptions.ts', import.meta.url)),
      'utf8'
    );
    expect(src).toMatch(/COALESCE\(ais\.trading_enabled, false\) = true/);
  });
});
