import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deskConfirmTickOpts } from '../scripts/livePaperDemo.js';
import type { Bar } from '../types.js';

function barsTrend(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.5;
    out.push({
      open: o,
      high: o + 1,
      low: o - 0.2,
      close: o + 0.8,
      ts_ms: i * 60_000,
    });
  }
  return out;
}

describe('live-paper desk confirm wiring', () => {
  it('deskConfirmTickOpts builds closed_10s from last bar', () => {
    const bars = barsTrend(20);
    const opts = deskConfirmTickOpts(bars, null);
    expect(opts.closed_10s.close).toBe(bars.at(-1)!.close);
    expect(opts.closed_10s.open).toBe(bars.at(-1)!.open);
    expect(opts.hour_bars.length).toBeGreaterThan(0);
  });

  it('prefers provided hour bars when enough', () => {
    const bars = barsTrend(10);
    const hours = barsTrend(8).map((b) => ({
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const opts = deskConfirmTickOpts(bars, hours);
    expect(opts.hour_bars).toBe(hours);
  });

  it('verify-gate strings: livePaperDemo feeds closed_10s + hour_bars', () => {
    const body = readFileSync(
      join(__dirname, '../scripts/livePaperDemo.ts'),
      'utf8'
    );
    expect(body).toMatch(/deskConfirmTickOpts/);
    expect(body).toMatch(/closed10sFromReplayBar/);
    expect(body).toMatch(/fetchYahooHourBars/);
    expect(body).toMatch(/desk_confirm_fed/);
    expect(body).toMatch(/desk_entry_source/);
    const honesty = readFileSync(
      join(__dirname, '../livePaperHonesty.ts'),
      'utf8'
    );
    expect(honesty).toMatch(/desk_confirm_fed !== true/);
    expect(honesty).toMatch(/desk !== 'setup' && desk !== 'move'/);
  });
});
