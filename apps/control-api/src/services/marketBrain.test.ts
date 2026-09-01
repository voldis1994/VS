import { describe, expect, it } from 'vitest';
import {
  brainEntryAllowed,
  brainExitParams,
  brainExitThesis,
  emptyBrainMemory,
  formatBrainLine,
  lockBrainAtEntry,
  summarizeBrain,
  updateMarketBrain,
} from './marketBrain.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

function withWarmup(tail: TenSecBar[], warm = 140): TenSecBar[] {
  const start = tail[0]?.open ?? 100;
  const out: TenSecBar[] = [];
  let p = start - 0.5;
  for (let i = 0; i < warm; i++) {
    const c = p + Math.sin(i / 7) * 0.02;
    out.push(bar(p, c + 0.05, c - 0.05, c, i));
    p = c;
  }
  const base = out.length;
  for (let j = 0; j < tail.length; j++) {
    out.push({ ...tail[j]!, open_time_ms: (base + j) * 10_000 });
  }
  return out;
}

describe('marketBrain unified state', () => {
  it('extends signal core with structure and action fields', () => {
    const tail: TenSecBar[] = [];
    let p = 100;
    for (let i = 0; i < 35; i++) {
      const c = p + Math.sin(i / 4) * 0.08;
      tail.push(bar(p, c + 0.1, c - 0.1, c, i));
      p = c;
    }
    const { state } = updateMarketBrain(withWarmup(tail), 'RANGE', emptyBrainMemory());
    expect(state.ready).toBe(true);
    expect(state.r_side).toBeGreaterThan(0);
    expect(state.move_state).toBeTruthy();
    expect(state.survival).toBeGreaterThanOrEqual(0);
    expect(state.exhaustion).toBeGreaterThanOrEqual(0);
    expect(typeof state.adjusted_target).toBe('number');
  });

  it('locks entry context for exit', () => {
    const tail: TenSecBar[] = [];
    let p = 100;
    for (let i = 0; i < 30; i++) {
      const c = p + 0.35;
      tail.push(bar(p, c + 0.3, c - 0.3, c, i));
      p = c;
    }
    const { state } = updateMarketBrain(withWarmup(tail), 'RANGE', emptyBrainMemory());
    const locked = lockBrainAtEntry(state, 110);
    expect(locked.r_side).toBeGreaterThan(0);
    expect(locked.break_dir).not.toBe(0);
  });

  it('provides dynamic exit params when brain is ready', () => {
    const tail: TenSecBar[] = [];
    let p = 100;
    for (let i = 0; i < 30; i++) {
      const c = p + 0.35;
      tail.push(bar(p, c + 0.3, c - 0.3, c, i));
      p = c;
    }
    const { state } = updateMarketBrain(withWarmup(tail), 'RANGE', emptyBrainMemory());
    const locked = lockBrainAtEntry(state, 110);
    const params = brainExitParams(state, locked, 111, 'BUY');
    expect(params.peakRet).toBeGreaterThan(0.2);
    expect(params.harvestRet).toBeGreaterThan(0.3);
  });

  it('gates FADE entry on sideways lifecycle', () => {
    const cold = updateMarketBrain([bar(100, 100.1, 99.9, 100)], 'RANGE').state;
    expect(brainEntryAllowed(cold, 'FADE').ok).toBe(false);
  });

  it('brainExitThesis fires on exhausting state', () => {
    const fake = {
      move_state: 'EXHAUSTING' as const,
      exhaustion: 0.9,
      survival: 0.1,
      side_end: false,
      break_valid: false,
      break_dir: 0 as const,
      used_potential: 0.5,
    };
    expect(brainExitThesis(fake as any, 'BUY', 'LONG')).toMatch(/BrainExhaustion/);
  });

  it('formatBrainLine summarizes for dashboard', () => {
    const summary = summarizeBrain(
      {
        ready: true,
        macro: 'BREAKOUT',
        regime: 'BREAKOUT_UP',
        confidence: 0.7,
        move_state: 'DEVELOPING',
        survival: 0.72,
        exhaustion: 0.2,
        used_potential: 0.41,
        remaining_pct: 59,
        adjusted_target: 4371.5,
        r_side: 5.4,
        break_valid: true,
        impulse: 0.65,
        side_confirmed: false,
        side_end: false,
        bar_count: 140,
      } as any,
      { adjusted_target: 4371.5, r_side: 5.4 } as any
    );
    const line = formatBrainLine(summary);
    expect(line).toMatch(/BRAIN · BREAKOUT/);
    expect(line).toMatch(/surv 72% \(10s\)/);
    expect(line).toMatch(/4371.50/);
  });

  it('formatBrainLine blocks entry while seeding', () => {
    const summary = summarizeBrain(
      { ready: false, bar_count: 45, macro: 'SIDEWAYS', regime: 'RANGE' } as any,
      null
    );
    expect(formatBrainLine(summary)).toMatch(/seeding 45\/137 — entry blocked/);
  });

  it('formatBrainLine shows manage mode while warming in trade', () => {
    const summary = summarizeBrain(
      { ready: false, bar_count: 90, macro: 'SIDEWAYS', regime: 'RANGE' } as any,
      null,
      { inTrade: true }
    );
    expect(formatBrainLine(summary)).toMatch(/warming 90\/137 · MANAGE \(playbook exit\)/);
  });
});
