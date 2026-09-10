import { describe, expect, it } from 'vitest';
import { analyzeBars } from '../analysis.js';
import { decide } from '../decision.js';
import {
  applyMarketFilters,
  effectiveSpreadCaps,
  isMetalEpic,
} from '../filters.js';
import { DEFAULT_MASTER_CONFIG } from '../pipeline.js';
import type { AnalysisSnapshot, Bar, Quote } from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2640 + i * 0.8;
    out.push({
      open: o,
      high: o + 1.2,
      low: o - 0.1,
      close: o + 0.9,
      ts_ms: i * 60_000,
    });
  }
  return out;
}

function quote(spread: number, mid = 2650): Quote {
  return {
    bid: mid - spread / 2,
    ask: mid + spread / 2,
    mid,
    spread,
    ts_ms: Date.now(),
    epic: 'GOLD',
  };
}

describe('GOLD spread filter — setup not false-blocked', () => {
  it('isMetalEpic recognizes GOLD aliases', () => {
    expect(isMetalEpic('GOLD')).toBe(true);
    expect(isMetalEpic('XAUUSD')).toBe(true);
    expect(isMetalEpic('EURUSD')).toBe(false);
  });

  it('effectiveSpreadCaps floors metals above FX-era 1.5 / 0.04%', () => {
    const tight = {
      ...DEFAULT_MASTER_CONFIG,
      max_spread_abs: 1.5,
      max_spread_pct: 0.0004,
      max_relative_spread: 1.5,
    };
    const caps = effectiveSpreadCaps(tight, 'GOLD');
    expect(caps.max_spread_abs).toBe(3);
    expect(caps.max_spread_pct).toBe(0.001);
    expect(caps.max_relative_spread).toBe(2.5);
    expect(effectiveSpreadCaps(tight, 'EURUSD').max_spread_abs).toBe(1.5);
  });

  it('GOLD spread 1.8 passes abs (old 1.5 would fail)', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      max_spread_abs: 1.5,
      max_spread_pct: 0.0004,
      block_off_hours: false,
      block_high_impact_news: false,
    };
    const failFx = applyMarketFilters(a, quote(1.8), cfg, Date.now(), bars, null, 'EURUSD');
    expect(failFx.ok).toBe(false);
    expect(failFx.reason).toBe('spread_abs');

    const okGold = applyMarketFilters(a, quote(1.8), cfg, Date.now(), bars, null, 'GOLD');
    expect(okGold.ok).toBe(true);
  });

  it('relative z-score alone does not block when abs is far under cap', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      block_off_hours: false,
      block_high_impact_news: false,
    };
    // Normal GOLD widen 0.5 with crazy z=6 — must not kill setup
    const v = applyMarketFilters(a, quote(0.5), cfg, Date.now(), bars, 6, 'GOLD');
    expect(v.ok).toBe(true);
    expect(v.checks.spread_relative).toBe(true);
  });

  it('insane GOLD spread still blocks (filter kept)', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      block_off_hours: false,
      block_high_impact_news: false,
    };
    const v = applyMarketFilters(a, quote(9), cfg, Date.now(), bars, null, 'GOLD');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('spread_abs');
  });

  it('setup_confirm_blocked WHY includes filter_reason (late_move)', () => {
    // Sideways book so SELL is not against_flow; last bar late for BUY only
    const bars: Bar[] = [];
    for (let i = 0; i < 40; i++) {
      const o = 2650 + Math.sin(i / 3) * 0.3;
      bars.push({
        open: o,
        high: o + 0.4,
        low: o - 0.4,
        close: o + 0.05,
        ts_ms: i * 60_000,
      });
    }
    const last = bars[bars.length - 1]!;
    bars[bars.length - 1] = {
      ...last,
      open: last.close - 8,
      high: last.close + 0.2,
      low: last.close - 8.2,
      close: last.close,
    };
    const a = analyzeBars(bars, 0.4) as AnalysisSnapshot;
    const d = decide(
      a,
      quote(0.4),
      {
        ...DEFAULT_MASTER_CONFIG,
        min_score: 0.01,
        require_armed_setup: true,
        block_off_hours: false,
        block_high_impact_news: false,
        max_relative_volatility: 100,
      },
      () => null,
      bars,
      null,
      null,
      {
        side: 'BUY',
        source: 'move',
        reason: 'test',
        setup_kind: 'NONE',
        playbook: null,
      }
    );
    expect(d.buy.filter_reason).toBe('late_move');
    expect(d.sell.filter_ok).toBe(true);
    expect(d.kind).toBe('WAIT');
    expect(d.block_reason).toMatch(/^setup_confirm_blocked:move:BUY:late_move$/);
  });
});
