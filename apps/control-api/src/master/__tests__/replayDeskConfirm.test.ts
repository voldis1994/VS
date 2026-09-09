import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  closed10sFromReplayBar,
  hourBarsFromReplayMinutes,
  replayMaster,
} from '../replay.js';
import type { Bar } from '../types.js';

function barsTrendUp(n = 40, start = 0): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({
      open: o,
      high: o + 1.2,
      low: o - 0.1,
      close: o + 0.9,
      ts_ms: (start + i) * 60_000,
    });
  }
  return out;
}

function barsTrendDown(n = 40, start = 0): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4500 - i * 0.8;
    out.push({
      open: o,
      high: o + 0.1,
      low: o - 1.2,
      close: o - 0.9,
      ts_ms: (start + i) * 60_000,
    });
  }
  return out;
}

describe('replay desk confirm (closed_10s / hour_bars parity)', () => {
  it('closed10sFromReplayBar mirrors bar OHLC as a just-closed 10s', () => {
    const bar: Bar = {
      open: 4410,
      high: 4412,
      low: 4409,
      close: 4411.5,
      ts_ms: 1_200_000,
    };
    const t = closed10sFromReplayBar(bar);
    expect(t.open).toBe(4410);
    expect(t.high).toBe(4412);
    expect(t.low).toBe(4409);
    expect(t.close).toBe(4411.5);
    expect(t.open_time_ms).toBe(1_190_000);
    expect(t.ticks).toBe(1);
  });

  it('hourBarsFromReplayMinutes aggregates 1m bars into hour candles', () => {
    const bars = barsTrendUp(90); // 1.5 hours of 1m bars
    const hours = hourBarsFromReplayMinutes(bars);
    expect(hours.length).toBeGreaterThanOrEqual(2);
    expect(hours[0]!.open).toBe(bars[0]!.open);
    expect(hours[0]!.high).toBeGreaterThanOrEqual(hours[0]!.open);
    expect(hours[0]!.snapshotTime).toBeTruthy();
  });

  it('default replay stamps setup|move desk_entry_source (not only |none)', async () => {
    const bars = [
      ...barsTrendUp(100, 0),
      ...barsTrendDown(100, 100),
      ...barsTrendUp(80, 200),
    ];
    const result = await replayMaster({
      bars,
      warmup: 30,
      spread: 0.5,
      cfg: {
        min_score: 0.25,
        require_armed_setup: false,
        block_off_hours: false,
        block_high_impact_news: false,
        require_positive_expectancy: false,
      },
    });
    const confirm = result.opportunities.filter(
      (o) =>
        o.decision?.desk_entry_source === 'setup' ||
        o.decision?.desk_entry_source === 'move'
    );
    expect(confirm.length).toBeGreaterThan(0);
    const setupKeys = result.opportunities
      .map((o) => o.setup_key)
      .filter((k): k is string => !!k);
    expect(
      setupKeys.some((k) => k.endsWith('|setup') || k.endsWith('|move'))
    ).toBe(true);
  });

  it('desk_confirm:false keeps legacy |none path', async () => {
    const bars = [...barsTrendUp(80), ...barsTrendDown(80)];
    const result = await replayMaster({
      bars,
      warmup: 25,
      spread: 0.5,
      desk_confirm: false,
      cfg: {
        min_score: 0.25,
        require_armed_setup: false,
        block_off_hours: false,
        block_high_impact_news: false,
        require_positive_expectancy: false,
      },
    });
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(
      result.opportunities.every(
        (o) =>
          !o.decision?.desk_entry_source ||
          o.decision.desk_entry_source === 'none'
      )
    ).toBe(true);
  });

  it('verify-gate strings: replay wires closed_10s + hour_bars', () => {
    const body = readFileSync(join(__dirname, '../replay.ts'), 'utf8');
    expect(body).toMatch(/closed10sFromReplayBar/);
    expect(body).toMatch(/hourBarsFromReplayMinutes/);
    expect(body).toMatch(/desk_confirm/);
    expect(body).toMatch(/closed_10s:\s*closed10sFromReplayBar/);
    expect(body).toMatch(/hour_bars:\s*hourBarsFromReplayMinutes/);
  });
});
