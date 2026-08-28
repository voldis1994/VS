/**
 * 5m universal trading brain — required scenario coverage.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  analyzeMarketStructure,
  closeBreaksLevel,
  wickOnlyBeyond,
  structuralStopLevel,
  thesisPivot,
  type StructureBar,
} from './marketStructure.js';
import {
  decideFiveMinuteEntry,
  decideFromLtfAlone,
  aggregateTenSecToFiveMin,
  blockLateChaseAdaptive,
} from './fiveMinuteBrain.js';
import { expandMinutesToTenSec, type TenSecBar } from './tenSecondOhlc.js';
import { allowMicrostructureFromBars } from './ohlcQuality.js';
import { allowEntryFromDataQuality, validateQuoteTiming } from './dataQuality.js';
import {
  resolveEntryPrice,
  nextClosePhaseAfterBrokerAck,
  shouldClearTradeState,
  recoverPendingExecution,
  adoptBrokerOpenForBo,
  buildBoStateFromOpen,
  saveBoState,
  loadBoState,
  resetTradeRecoveryStore,
  persistRiskSnapshotJson,
  loadRiskSnapshotJson,
} from './tradeRecovery.js';
import {
  decideBestOutcomeExit,
  bestOutcomeMfeFloor,
  hardInvalidationDistance,
} from './exitManage.js';
import { hardInvalidationDistance as thrHard } from './microScalpThresholds.js';
import { atrWilder } from './volatilityNorm.js';
import { isExecutableQuote, tagExecutionQuote, tagReferenceQuote } from './multiFeedRoles.js';
import { RISK_WINDOW_MS, resetRiskWindows, setRiskEquity, noteRiskTradeOpen, getRiskSnapshot } from './riskWindow.js';
import { robotIdFor } from './robotDesk.js';

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  provenance: 'REAL' | 'SYNTHETIC' = 'REAL'
): StructureBar {
  return { open_time_ms: t, open: o, high: h, low: l, close: c, ticks: 8, provenance };
}

/** Build HH/HL uptrend then bullish BOS through last swing high. */
function bullishBosSeries(n = 40): StructureBar[] {
  const out: StructureBar[] = [];
  let t = 0;
  // Base: rising swings
  for (let i = 0; i < n - 3; i++) {
    const base = 100 + i * 0.4;
    const isHighPivot = i % 5 === 2;
    const isLowPivot = i % 5 === 4;
    const o = base;
    const c = base + (isHighPivot ? 0.8 : isLowPivot ? -0.2 : 0.2);
    const h = Math.max(o, c) + (isHighPivot ? 0.6 : 0.15);
    const l = Math.min(o, c) - (isLowPivot ? 0.5 : 0.15);
    out.push(bar(t, o, h, l, c));
    t += 300_000;
  }
  const lastSwingHigh = Math.max(...out.slice(-12).map((b) => b.high));
  // Displacement breakout close above
  out.push(bar(t, lastSwingHigh - 0.1, lastSwingHigh + 1.2, lastSwingHigh - 0.3, lastSwingHigh + 1.0));
  t += 300_000;
  out.push(bar(t, lastSwingHigh + 0.9, lastSwingHigh + 1.1, lastSwingHigh + 0.7, lastSwingHigh + 1.05));
  t += 300_000;
  out.push(bar(t, lastSwingHigh + 1.0, lastSwingHigh + 1.15, lastSwingHigh + 0.85, lastSwingHigh + 1.1));
  return out;
}

function bearishBosSeries(n = 40): StructureBar[] {
  const out: StructureBar[] = [];
  let t = 0;
  for (let i = 0; i < n - 3; i++) {
    const base = 200 - i * 0.4;
    const isHighPivot = i % 5 === 2;
    const isLowPivot = i % 5 === 4;
    const o = base;
    const c = base - (isLowPivot ? 0.8 : isHighPivot ? -0.2 : 0.2);
    const h = Math.max(o, c) + (isHighPivot ? 0.5 : 0.15);
    const l = Math.min(o, c) - (isLowPivot ? 0.6 : 0.15);
    out.push(bar(t, o, h, l, c));
    t += 300_000;
  }
  const lastSwingLow = Math.min(...out.slice(-12).map((b) => b.low));
  out.push(bar(t, lastSwingLow + 0.1, lastSwingLow + 0.3, lastSwingLow - 1.2, lastSwingLow - 1.0));
  t += 300_000;
  out.push(bar(t, lastSwingLow - 0.9, lastSwingLow - 0.7, lastSwingLow - 1.1, lastSwingLow - 1.05));
  t += 300_000;
  out.push(bar(t, lastSwingLow - 1.0, lastSwingLow - 0.85, lastSwingLow - 1.15, lastSwingLow - 1.1));
  return out;
}

function ltfConfirmUp(price: number): StructureBar[] {
  const out: StructureBar[] = [];
  for (let i = 0; i < 12; i++) {
    const o = price + i * 0.05;
    out.push(bar(i * 10_000, o, o + 0.08, o - 0.02, o + 0.06));
  }
  return out;
}

function ltfConfirmDown(price: number): StructureBar[] {
  const out: StructureBar[] = [];
  for (let i = 0; i < 12; i++) {
    const o = price - i * 0.05;
    out.push(bar(i * 10_000, o, o + 0.02, o - 0.08, o - 0.06));
  }
  return out;
}

/** Clean alternating zigzag — every bar is a fractal extreme (works with pivotLeft/Right=1). */
function zigzagUp(n: number, startTrend = 100, step = 1.2): StructureBar[] {
  const bars: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const trend = startTrend + i * step;
    let o: number, h: number, l: number, c: number;
    if (i % 2 === 0) {
      l = trend - 1.5;
      h = trend + 0.1;
      o = trend - 0.2;
      c = trend;
    } else {
      h = trend + 1.5;
      l = trend - 0.1;
      o = trend;
      c = trend + 0.3;
    }
    bars.push(bar(i * 300_000, o, h, l, c));
  }
  return bars;
}

function zigzagDown(n: number, startTrend = 200, step = 1.2): StructureBar[] {
  const bars: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const trend = startTrend - i * step;
    let o: number, h: number, l: number, c: number;
    if (i % 2 === 0) {
      h = trend + 1.5;
      l = trend - 0.1;
      o = trend;
      c = trend - 0.3;
    } else {
      l = trend - 1.5;
      h = trend + 0.1;
      o = trend - 0.2;
      c = trend - 0.5;
    }
    bars.push(bar(i * 300_000, o, h, l, c));
  }
  return bars;
}

/** Smooth sine-wave zigzag — survives the default (left=2,right=2) pivot window. */
function waveUp(n: number, base = 100, amp = 3, period = 10, drift = 0.6): StructureBar[] {
  const bars: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const center = base + i * drift + amp * Math.sin((2 * Math.PI * i) / period);
    bars.push(bar(i * 300_000, center - 0.1, center + 0.5, center - 0.5, center + 0.1));
  }
  return bars;
}

describe('5m market structure', () => {
  it('14. labels HH/HL on rising pivots', () => {
    const bars = zigzagUp(20);
    const ms = analyzeMarketStructure(bars, { pivotLeft: 1, pivotRight: 1 });
    expect(ms.pivots.length).toBeGreaterThan(0);
    expect(ms.trend).toBe('UP');
    expect(ms.swing_labels.high).toBe('HH');
    expect(ms.swing_labels.low).toBe('HL');
  });

  it('12. wick-only beyond level is NOT breakout', () => {
    const b = bar(0, 100, 105, 99.5, 100.2); // wick high 105, close back
    expect(wickOnlyBeyond(b, 103, 'ABOVE')).toBe(true);
    expect(closeBreaksLevel(b, 103, 'ABOVE')).toBe(false);
  });

  it('15. BOS detected on bullish continuation close acceptance', () => {
    const base = zigzagUp(21);
    const ms0 = analyzeMarketStructure(base, { pivotLeft: 1, pivotRight: 1 });
    const sh = ms0.last_swing_high!.price;
    const breakout = bar(
      base[base.length - 1]!.open_time_ms + 300_000,
      sh - 0.2,
      sh + 2.5,
      sh - 0.3,
      sh + 2.2
    );
    const ms = analyzeMarketStructure([...base, breakout], { pivotLeft: 1, pivotRight: 1 });
    const kinds = ms.events.map((e) => e.kind);
    expect(kinds).toContain('BOS');
    expect(kinds).toContain('BREAKOUT');
    expect(kinds).toContain('DISPLACEMENT');
    expect(ms.events.find((e) => e.kind === 'BOS')!.side).toBe('BULL');
  });

  it('16. CHoCH detected when a prior downtrend breaks bullish', () => {
    const base = zigzagDown(20);
    const ms0 = analyzeMarketStructure(base, { pivotLeft: 1, pivotRight: 1 });
    expect(ms0.trend).toBe('DOWN');
    const sh = ms0.last_swing_high!.price;
    const breakout = bar(
      base[base.length - 1]!.open_time_ms + 300_000,
      sh - 0.2,
      sh + 2.5,
      sh - 0.3,
      sh + 2.2
    );
    const ms = analyzeMarketStructure([...base, breakout], { pivotLeft: 1, pivotRight: 1 });
    const kinds = ms.events.map((e) => e.kind);
    expect(kinds).toContain('CHOCH');
    expect(kinds).toContain('BREAKOUT');
    expect(ms.events.find((e) => e.kind === 'CHOCH')!.side).toBe('BULL');
  });

  it('13. sweep + reclaim on wick through swing low', () => {
    const base = zigzagUp(20);
    const ms0 = analyzeMarketStructure(base, { pivotLeft: 1, pivotRight: 1 });
    const sl = ms0.last_swing_low!.price;
    const sweepBar = bar(
      base[base.length - 1]!.open_time_ms + 300_000,
      sl + 0.3,
      sl + 0.5,
      sl - 0.6,
      sl + 0.2
    );
    const ms = analyzeMarketStructure([...base, sweepBar], { pivotLeft: 1, pivotRight: 1 });
    const kinds = ms.events.map((e) => e.kind);
    expect(wickOnlyBeyond(sweepBar, sl, 'BELOW')).toBe(true);
    expect(kinds).toContain('SWEEP');
    expect(kinds).toContain('RECLAIM');
    expect(ms.events.find((e) => e.kind === 'SWEEP')!.side).toBe('BULL');
    expect(ms.events.find((e) => e.kind === 'RECLAIM')!.side).toBe('BULL');
  });

  it('17. failed breakout after close beyond then reject', () => {
    const base = zigzagUp(21);
    const ms0 = analyzeMarketStructure(base, { pivotLeft: 1, pivotRight: 1 });
    const sh = ms0.last_swing_high!.price;
    const t0 = base[base.length - 1]!.open_time_ms;
    // Small wick above sh so this bar itself does not become a new fractal high.
    const breakBar = bar(t0 + 300_000, sh - 0.1, sh + 0.3, sh - 0.2, sh + 0.15);
    const failBar = bar(t0 + 600_000, sh + 0.1, sh + 0.4, sh - 0.5, sh - 0.2);
    expect(closeBreaksLevel(breakBar, sh, 'ABOVE')).toBe(true);
    expect(failBar.close).toBeLessThan(sh);
    expect(failBar.close).toBeLessThan(breakBar.close);
    const ms = analyzeMarketStructure([...base, breakBar, failBar], { pivotLeft: 1, pivotRight: 1 });
    const kinds = ms.events.map((e) => e.kind);
    expect(kinds).toContain('FAILED_BREAKOUT');
    expect(ms.events.find((e) => e.kind === 'FAILED_BREAKOUT')!.side).toBe('BEAR');
  });

  it('18. structural SL BUY below pivot low + buffer', () => {
    const bars = bullishBosSeries();
    const ms = analyzeMarketStructure(bars, { pivotLeft: 1, pivotRight: 1 });
    const pivot = thesisPivot(ms, 'BUY');
    const sl = structuralStopLevel('BUY', pivot, {
      price: bars[bars.length - 1]!.close,
      atr: ms.atr,
      spread: 0.1,
    });
    expect(sl).not.toBeNull();
    if (pivot && sl != null) expect(sl).toBeLessThan(pivot.price);
  });

  it('19. structural SL SELL above pivot high + buffer', () => {
    const bars = bearishBosSeries();
    const ms = analyzeMarketStructure(bars, { pivotLeft: 1, pivotRight: 1 });
    const pivot = thesisPivot(ms, 'SELL');
    const sl = structuralStopLevel('SELL', pivot, {
      price: bars[bars.length - 1]!.close,
      atr: ms.atr,
      spread: 0.1,
    });
    expect(sl).not.toBeNull();
    if (pivot && sl != null) expect(sl).toBeGreaterThan(pivot.price);
  });
});

describe('5m entry pipeline', () => {
  it('20. LTF alone cannot open trade', () => {
    const d = decideFromLtfAlone(ltfConfirmUp(100));
    expect(d.entry).toBe(false);
    expect(d.hard_block).toBe('LTF_ONLY');
  });

  it('21. valid 5m setup + LTF confirmation can open', () => {
    // Smooth wave uptrend (survives default left=2/right=2 pivots) + a displacement
    // breakout candle on the last closed 5m bar → clean BOS + full evidence stack.
    const base = waveUp(30);
    const ms0 = analyzeMarketStructure(base);
    const sh = ms0.last_swing_high!.price;
    const breakout = bar(
      base[base.length - 1]!.open_time_ms + 300_000,
      sh - 0.3,
      sh + 2.5,
      sh - 0.4,
      sh + 2.2
    );
    const bars5m = [...base, breakout];
    const price = bars5m[bars5m.length - 1]!.close;
    const d = decideFiveMinuteEntry({
      bars5m,
      bars1m: ltfConfirmUp(price),
      bars10s: ltfConfirmUp(price),
      regime: 'TREND_UP',
      price,
      spread: 0.05,
      feed_agreement: 0.9,
      htf: { trend: 'UP', near_support: true },
      tick_size: 0.01,
    });
    expect(d.hard_block).toBeNull();
    expect(d.entry).toBe(true);
    expect(d.direction).toBe('BUY');
    expect(d.setup).toBe('CONTINUATION');
    expect(d.structural_sl).not.toBeNull();
    expect(d.structure.events.map((e) => e.kind)).toContain('BOS');
  });

  it('10. synthetic data cannot trigger microstructure', () => {
    const minutes = Array.from({ length: 20 }, (_, i) => ({
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
    }));
    const syn = expandMinutesToTenSec(minutes);
    expect(syn.every((b) => b.provenance === 'SYNTHETIC')).toBe(true);
    const gate = allowMicrostructureFromBars(syn);
    expect(gate.ok).toBe(false);
    const five = aggregateTenSecToFiveMin(syn as StructureBar[]);
    expect(five.length).toBe(0);
  });

  it('11. stale data cannot trigger entry', () => {
    const now = Date.now();
    const v = validateQuoteTiming(
      { mid: 100, fetch_ms: now - 60_000, source_ms: now - 60_000 },
      { nowMs: now, maxStaleMs: 15_000 }
    );
    expect(v.ok).toBe(false);
    expect(v.stale).toBe(true);
    expect(allowEntryFromDataQuality({ mid: 100, fetch_ms: now - 60_000 }, { nowMs: now }).ok).toBe(
      false
    );
  });
});

describe('execution truth + close + recovery', () => {
  beforeEach(() => resetTradeRecoveryStore());

  it('1. actual Capital fill → BO entry', () => {
    const fill = resolveEntryPrice({
      broker_open_level: 4651.2,
      signal_mid: 4650.0,
    });
    expect(fill).toBe(4651.2);
    const bo = buildBoStateFromOpen({
      deal_id: 'D1',
      side: 'BUY',
      entry_price: fill!,
      epic: 'GOLD',
      account_id: 1,
      robot_id: '1:GOLD',
    });
    expect(bo.entry_price).toBe(4651.2);
  });

  it('2. slippage handling prefers broker over signal; signal alone is NOT fill truth', () => {
    expect(
      resolveEntryPrice({ broker_open_level: 1.1005, signal_mid: 1.1, confirm_level: 1.1002 })
    ).toBe(1.1005);
    expect(resolveEntryPrice({ signal_mid: 1.1 })).toBeNull();
    expect(resolveEntryPrice({ confirm_level: 1.1002, signal_mid: 1.1 })).toBe(1.1002);
  });

  it('3. close ok + broker still open → NOT CLOSED', () => {
    const phase = nextClosePhaseAfterBrokerAck(true);
    expect(phase).toBe('CLOSE_UNCERTAIN');
    expect(shouldClearTradeState(phase)).toBe(false);
  });

  it('4. confirmed broker close → CLOSED', () => {
    const phase = nextClosePhaseAfterBrokerAck(false);
    expect(phase).toBe('CLOSED');
    expect(shouldClearTradeState(phase)).toBe(true);
  });

  it('5. crash/pending execution recovery', () => {
    const adopt = recoverPendingExecution({
      pending: {
        robot_id: '1:X',
        account_id: 1,
        epic: 'X',
        side: 'BUY',
        deal_reference: 'ref',
        claimed_at: new Date().toISOString(),
        signal_mid: 10,
      },
      brokerOpen: { deal_id: 'D', direction: 'BUY', open_level: 10.1 },
    });
    expect(adopt.action).toBe('ADOPT');
    // Without any broker position and no deal reference, we cannot yet tell
    // whether the order truly failed or simply hasn't synced — WAIT, never clear blind.
    const wait = recoverPendingExecution({
      pending: {
        robot_id: '1:X',
        account_id: 1,
        epic: 'X',
        side: 'BUY',
        deal_reference: null,
        claimed_at: new Date().toISOString(),
        signal_mid: 10,
      },
      brokerOpen: null,
    });
    expect(wait.action).toBe('WAIT');
  });

  it('6/7. restart with open position + MFE/MAE recovery', () => {
    const prior = buildBoStateFromOpen({
      deal_id: 'D9',
      side: 'SELL',
      entry_price: 50,
      mfe: 1.5,
      mae: -0.2,
      peak_favorable: 48.5,
      peak_retention: 0.8,
      structural_sl: 51,
      epic: 'EU',
      account_id: 2,
      robot_id: '2:EU',
    });
    saveBoState(prior);
    const adopted = adoptBrokerOpenForBo({
      prior: loadBoState('2:EU'),
      deal_id: 'D9',
      side: 'SELL',
      open_level: 50,
      epic: 'EU',
      account_id: 2,
      robot_id: '2:EU',
    });
    expect(adopted.mfe).toBe(1.5);
    expect(adopted.mae).toBe(-0.2);
    expect(adopted.structural_sl).toBe(51);
  });

  it('8. riskWindow recovery 60min', () => {
    resetRiskWindows();
    expect(RISK_WINDOW_MS).toBe(60 * 60 * 1000);
    setRiskEquity(7, 10_000);
    noteRiskTradeOpen(7);
    const snap = getRiskSnapshot(7, 0);
    persistRiskSnapshotJson(7, snap);
    const loaded = loadRiskSnapshotJson(7) as { status: string };
    expect(loaded.status).toBe('ACTIVE');
    expect(snap.detail).toMatch(/60|active/i);
  });
});

describe('universality + feeds + isolation', () => {
  it('9. Gold/FX/index/crypto same HardInv logic (no abs>=1000 Gold branch)', () => {
    const meta = { tick_size: 0.01 };
    const gold = thrHard(4660, null, meta)!;
    const fx = thrHard(1.1, null, { tick_size: 0.0001 })!;
    const idx = thrHard(450, null, meta)!;
    const crypto = thrHard(65000, null, { tick_size: 1 })!;
    expect(gold).toBeGreaterThan(0);
    expect(fx).toBeGreaterThan(0);
    expect(idx).toBeGreaterThan(0);
    expect(crypto).toBeGreaterThan(0);
    // Gold distance ≈ pct * price, not hardcoded 2.0-only branch
    expect(Math.abs(gold - 4660 * 0.00043)).toBeLessThan(0.05);
  });

  it('reference feed is not executable zero-spread', () => {
    const ref = tagReferenceQuote('Yahoo', 4660);
    expect(isExecutableQuote(ref)).toBe(false);
    const exec = tagExecutionQuote({ bid: 4659.5, ask: 4660.5, mid: 4660 });
    expect(isExecutableQuote(exec)).toBe(true);
  });

  it('23. multi-client isolation robot ids', () => {
    expect(robotIdFor(1, 'GOLD')).not.toBe(robotIdFor(2, 'GOLD'));
  });

  it('24. BO hybrid PeakTrail after arm on deep giveback', () => {
    const entry = 100;
    const atr = 3;
    const cut = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: entry,
        entry_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        mfe: 12,
        mae: 0,
        peak_retention: 0.5,
        atr,
        tick_size: 0.01,
        regime: 'TREND_UP',
        structure_target: 20,
      },
      entry + 2,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakRetention|PeakTrail/);
  });

  it('structural invalidation BUY', () => {
    const cut = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 100,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
        mfe: 0,
        mae: 0,
        peak_retention: null,
        structural_sl: 99,
      },
      98.5
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/StructuralInvalidation/);
  });
});

describe('anti-chase adaptive', () => {
  it('blocks climax overextension', () => {
    const bars: StructureBar[] = [];
    for (let i = 0; i < 8; i++) {
      const o = 100 + i * 2;
      bars.push(bar(i * 300_000, o, o + 2.2, o - 0.1, o + 2));
    }
    // last bars stall at high
    bars.push(bar(9 * 300_000, 116, 116.1, 115.8, 116.0));
    bars.push(bar(10 * 300_000, 116, 116.05, 115.9, 115.95));
    const atr = atrWilder(bars, 14);
    const r = blockLateChaseAdaptive('BUY', bars, atr);
    expect(r.ok).toBe(false);
  });
});
