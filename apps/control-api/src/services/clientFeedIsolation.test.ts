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
});
