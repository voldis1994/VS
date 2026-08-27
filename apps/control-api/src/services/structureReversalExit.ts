/**
 * BO structure-reversal exit — HOLD while thesis alive; exit on real market shift.
 * Uses 5m structure + 1m micro + 10s confirmation + ATR buffer.
 */

import {
  analyzeMarketStructure,
  closeBreaksLevel,
  hasEvent,
  type StructureBar,
} from './marketStructure.js';
import { isRealBar } from './ohlcQuality.js';
import { moveThresholdPts } from './volatilityNorm.js';

export type ExitSide = 'BUY' | 'SELL';

export type StructureReversalInput = {
  side: ExitSide;
  price: number;
  entry: number;
  mfe: number;
  bars5m: StructureBar[];
  bars1m?: StructureBar[] | null;
  bars10s?: StructureBar[] | null;
  atr?: number | null;
  tick_size?: number | null;
  structure_target?: number | null;
  continuationSameSide?: boolean;
};

export type StructureReversalResult = {
  exit: boolean;
  reason: string;
  thesisAlive: boolean;
  detail: string;
};

function realBars(bars: StructureBar[] | null | undefined): StructureBar[] {
  return (bars ?? []).filter((b) => isRealBar(b) && !b.forming);
}

/** BUY thesis alive when 5m trend/structure supports continuation without bear CHoCH. */
export function thesisAlive5m(side: ExitSide, bars5m: StructureBar[]): { alive: boolean; detail: string } {
  const bars = realBars(bars5m);
  if (bars.length < 6) return { alive: true, detail: '5m seeding — assume thesis' };
  const ms = analyzeMarketStructure(bars, { pivotLeft: 1, pivotRight: 1 });
  const { high, low } = ms.swing_labels;

  if (side === 'BUY') {
    const bearChoch = hasEvent(ms, 'CHOCH', 'BEAR');
    const bearFail = hasEvent(ms, 'FAILED_BREAKOUT', 'BEAR');
    if (bearChoch) return { alive: false, detail: `5m CHoCH BEAR · ${bearChoch.detail}` };
    if (bearFail) return { alive: false, detail: `5m failed bull · ${bearFail.detail}` };
    if (low === 'LL' && high === 'LH') {
      return { alive: false, detail: `5m LL/LH bear · ${ms.trend}` };
    }
    if (ms.trend === 'UP' || (high === 'HH' && low === 'HL')) {
      return { alive: true, detail: `5m bull · ${high ?? '?'}/${low ?? '?'} · ${ms.trend}` };
    }
    if (ms.trend === 'DOWN') {
      return { alive: false, detail: `5m trend DOWN vs BUY · ${high ?? '?'}/${low ?? '?'}` };
    }
    return { alive: true, detail: `5m mixed · ${high ?? '?'}/${low ?? '?'} · hold retrace` };
  }

  const bullChoch = hasEvent(ms, 'CHOCH', 'BULL');
  const bullFail = hasEvent(ms, 'FAILED_BREAKOUT', 'BULL');
  if (bullChoch) return { alive: false, detail: `5m CHoCH BULL · ${bullChoch.detail}` };
  if (bullFail) return { alive: false, detail: `5m failed bear · ${bullFail.detail}` };
  if (high === 'HH' && low === 'HL') {
    return { alive: false, detail: `5m HH/HL bull vs SELL · ${ms.trend}` };
  }
  if (ms.trend === 'DOWN' || (low === 'LL' && high === 'LH')) {
    return { alive: true, detail: `5m bear · ${high ?? '?'}/${low ?? '?'} · ${ms.trend}` };
  }
  if (ms.trend === 'UP') {
    return { alive: false, detail: `5m trend UP vs SELL · ${high ?? '?'}/${low ?? '?'}` };
  }
  return { alive: true, detail: `5m mixed · ${high ?? '?'}/${low ?? '?'} · hold retrace` };
}

function pivotBreakExit(
  side: ExitSide,
  price: number,
  bars5m: StructureBar[],
  atr: number | null,
  tickSize: number | null
): string | null {
  const bars = realBars(bars5m);
  if (bars.length < 4) return null;
  const ms = analyzeMarketStructure(bars, { pivotLeft: 1, pivotRight: 1 });
  const last = bars[bars.length - 1]!;
  const buf =
    moveThresholdPts(price, atr, 0.08, 0.00015) ??
    (atr != null && atr > 0 ? atr * 0.08 : null);
  if (buf == null) return null;

  if (side === 'BUY' && ms.last_swing_low) {
    const lvl = ms.last_swing_low.price;
    if (closeBreaksLevel(last, lvl - buf * 0.2, 'BELOW')) {
      return `StructureBreak · BUY HL broken · close ${last.close.toFixed(5)} < HL ${lvl.toFixed(5)}`;
    }
  }
  if (side === 'SELL' && ms.last_swing_high) {
    const lvl = ms.last_swing_high.price;
    if (closeBreaksLevel(last, lvl + buf * 0.2, 'ABOVE')) {
      return `StructureBreak · SELL LH broken · close ${last.close.toFixed(5)} > LH ${lvl.toFixed(5)}`;
    }
  }
  void tickSize;
  return null;
}

function microReversalConfirm(
  side: ExitSide,
  bars1m: StructureBar[],
  bars10s: StructureBar[]
): string | null {
  const b1 = realBars(bars1m);
  const b10 = realBars(bars10s);
  if (b1.length >= 4) {
    const ms1 = analyzeMarketStructure(b1.slice(-24), { pivotLeft: 1, pivotRight: 1 });
    if (side === 'BUY') {
      const ev =
        hasEvent(ms1, 'CHOCH', 'BEAR') ||
        hasEvent(ms1, 'RECLAIM', 'BEAR') ||
        hasEvent(ms1, 'FAILED_BREAKOUT', 'BEAR');
      if (ev) return `MicroReversal · 1m ${ev.kind} BEAR · ${ev.detail}`;
    } else {
      const ev =
        hasEvent(ms1, 'CHOCH', 'BULL') ||
        hasEvent(ms1, 'RECLAIM', 'BULL') ||
        hasEvent(ms1, 'FAILED_BREAKOUT', 'BULL');
      if (ev) return `MicroReversal · 1m ${ev.kind} BULL · ${ev.detail}`;
    }
  }
  if (b10.length >= 2) {
    const last = b10[b10.length - 1]!;
    const prev = b10[b10.length - 2]!;
    if (side === 'BUY' && last.close < prev.close && last.close < last.open) {
      const body = Math.abs(last.close - last.open);
      const upper = last.high - Math.max(last.open, last.close);
      if (upper >= body * 1.1) return 'MicroReversal · 10s bear rejection after peak';
    }
    if (side === 'SELL' && last.close > prev.close && last.close > last.open) {
      const body = Math.abs(last.close - last.open);
      const lower = Math.min(last.open, last.close) - last.low;
      if (lower >= body * 1.1) return 'MicroReversal · 10s bull rejection after trough';
    }
  }
  return null;
}

/**
 * Detect structure-based exit. Normal retrace alone does NOT exit.
 * Peak MFE is tracked externally (s.mfe) — not used as a scalp trigger here.
 */
export function detectStructureReversalExit(
  input: StructureReversalInput
): StructureReversalResult {
  const fav =
    input.side === 'BUY' ? input.price - input.entry : input.entry - input.price;
  const cont = Boolean(input.continuationSameSide);
  const thesis = thesisAlive5m(input.side, input.bars5m);

  const structTarget =
    input.structure_target != null &&
    Number.isFinite(input.structure_target) &&
    input.structure_target > 0
      ? input.structure_target
      : null;
  const atTarget = structTarget != null && fav + 1e-9 >= structTarget;

  // Structure target reached — exit only when continuation ended
  if (atTarget && !cont && !thesis.alive) {
    return {
      exit: true,
      reason: `TargetEnd · structure ${structTarget!.toFixed(5)} · continuation ended · ${thesis.detail}`,
      thesisAlive: false,
      detail: thesis.detail,
    };
  }
  if (atTarget && !cont) {
    return {
      exit: true,
      reason: `TargetEnd · UPL ${fav.toFixed(5)} ≥ structure ${structTarget!.toFixed(5)} · continuation ended`,
      thesisAlive: false,
      detail: thesis.detail,
    };
  }

  const pivotBreak = pivotBreakExit(
    input.side,
    input.price,
    input.bars5m,
    input.atr ?? null,
    input.tick_size ?? null
  );
  if (pivotBreak) {
    return { exit: true, reason: pivotBreak, thesisAlive: false, detail: thesis.detail };
  }

  if (!thesis.alive) {
    return {
      exit: true,
      reason: `StructureReversal · ${thesis.detail}`,
      thesisAlive: false,
      detail: thesis.detail,
    };
  }

  const micro = microReversalConfirm(
    input.side,
    input.bars1m ?? [],
    input.bars10s ?? []
  );
  // Require micro confirm only after meaningful MFE — avoid flicker on young trades
  const minMfe =
    input.atr != null && input.atr > 0 ? input.atr * 0.25 : Math.abs(input.entry) * 0.0002;
  if (micro && input.mfe >= minMfe && !cont) {
    return { exit: true, reason: micro, thesisAlive: false, detail: thesis.detail };
  }

  return {
    exit: false,
    reason: '',
    thesisAlive: thesis.alive,
    detail: thesis.detail,
  };
}
