import { describe, expect, it } from 'vitest';
import {
  deskCycleHealth,
  DESK_CYCLE_BUSY_WARN_MS,
  DESK_CYCLE_BUSY_STUCK_MS,
  DESK_LIVE_LOG_STALE_MS,
} from './deskCycleHealth.js';
import {
  CYCLE_BUSY_WARN_MS,
  CYCLE_BUSY_STUCK_MS,
  CYCLE_BUSY_STALE_MS,
  CYCLE_WALL_MS,
  LIVE_LOG_STALE_MS,
} from './robotDesk.js';

describe('deskCycleHealth — no false STUCK on multi-account Capital queue', () => {
  it('keeps warn/stuck/stale thresholds aligned with robotDesk exports', () => {
    expect(DESK_CYCLE_BUSY_WARN_MS).toBe(CYCLE_BUSY_WARN_MS);
    expect(DESK_CYCLE_BUSY_STUCK_MS).toBe(CYCLE_BUSY_STUCK_MS);
    expect(DESK_LIVE_LOG_STALE_MS).toBe(LIVE_LOG_STALE_MS);
    expect(CYCLE_BUSY_WARN_MS).toBeLessThan(CYCLE_BUSY_STUCK_MS);
    expect(CYCLE_BUSY_STUCK_MS).toBeLessThan(CYCLE_BUSY_STALE_MS);
    expect(CYCLE_WALL_MS).toBeLessThan(CYCLE_BUSY_STALE_MS);
  });

  it('8–14s busy is OK (was false CYCLE STUCK at 8s)', () => {
    expect(
      deskCycleHealth({
        running: true,
        cycle_busy: true,
        cycle_busy_age_ms: 8_000,
      }).level
    ).toBe('ok');
    expect(
      deskCycleHealth({
        running: true,
        cycle_busy: true,
        cycle_busy_age_ms: 14_000,
      }).level
    ).toBe('ok');
  });

  it('15–39s busy is soft warn (Capital queue), not STUCK', () => {
    const h = deskCycleHealth({
      running: true,
      cycle_busy: true,
      cycle_busy_age_ms: 25_000,
    });
    expect(h).toEqual({ level: 'warn', age_s: 25, kind: 'capital_busy' });
  });

  it('40s+ busy is hard STUCK', () => {
    const h = deskCycleHealth({
      running: true,
      cycle_busy: true,
      cycle_busy_age_ms: 49_000,
    });
    expect(h).toEqual({ level: 'stuck', age_s: 49 });
  });

  it('does not show LIVE LOG stale while cycle_busy (ticks pause by design)', () => {
    const now = Date.now();
    expect(
      deskCycleHealth({
        running: true,
        cycle_busy: true,
        cycle_busy_age_ms: 10_000,
        last_tick_at: new Date(now - 51_000).toISOString(),
        now,
      }).level
    ).toBe('ok');
  });

  it('stale log only when idle >45s', () => {
    const now = Date.now();
    expect(
      deskCycleHealth({
        running: true,
        cycle_busy: false,
        last_activity_at: new Date(now - 30_000).toISOString(),
        now,
      }).level
    ).toBe('ok');
    expect(
      deskCycleHealth({
        running: true,
        cycle_busy: false,
        last_quote_at: new Date(now - 51_000).toISOString(),
        now,
      })
    ).toEqual({ level: 'stale_log', age_s: 51 });
  });
});
