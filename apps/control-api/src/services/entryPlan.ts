/**
 * Live ENTRY plan for desk UI — shows WHERE/WHY/WAIT before fill.
 */

import {
  advanceEarlyEntryArmed,
  idleArmedState,
  locateEarlyZone,
  scoreMicroConfirmation,
  type ArmedPhase,
  type ArmedTriggerState,
} from './earlyEntryArmed.js';
import { analyzeMarketStructure, hasEvent, type StructureBar } from './marketStructure.js';
import type { MultiTfState } from './timeframeBooks.js';
import { buildHtfContextFromBooks } from './timeframeBooks.js';
import { isRealBar } from './ohlcQuality.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type EntryPlanUiState = 'WATCHING' | 'ARMED' | 'TRIGGERED' | 'INVALIDATED';

export type PriceVsZone = 'IN' | 'ABOVE' | 'BELOW' | null;

export type EntryPlan = {
  state: EntryPlanUiState;
  bias: 'BUY' | 'SELL' | null;
  entry_zone: { low: number; high: number } | null;
  /** Soft band inside entry zone where we want price before ARMED — NOT a live order trigger. */
  trigger_zone: { low: number; high: number } | null;
  current_price: number | null;
  invalidation: number | null;
  structure_target: number | null;
  /** Why fill has not happened yet — human-facing, primary UI line. */
  waiting_for: string;
  /** Short block: PRICE_ABOVE_ZONE / NEED_MICRO / … */
  block_reason: string;
  price_vs_zone: PriceVsZone;
  trigger_10s: string;
  trigger_1m: string;
  htf_context: string;
  micro_score: number;
  micro_confirms: string[];
  detail: string;
};

const MICRO_ENTRY = 2;

export function mapArmedPhaseToUi(phase: ArmedPhase): EntryPlanUiState {
  if (phase === 'ARMED') return 'ARMED';
  if (phase === 'TRIGGERED') return 'TRIGGERED';
  if (phase === 'INVALIDATED') return 'INVALIDATED';
  return 'WATCHING';
}

function tfTrendLine(state: MultiTfState | null | undefined): string {
  if (!state?.ready) return 'HTF seeding';
  const tag = (key: '5m' | '15m' | '1H' | '4H') => {
    const book = state.books[key];
    if (!book?.ready || book.bars.length < 6) return `${key}=?`;
    const bars = book.bars.filter((b) => isRealBar(b) && !b.forming);
    if (bars.length < 6) return `${key}=?`;
    const ms = analyzeMarketStructure(
      bars.map((b) => ({
        open_time_ms: b.open_time_ms,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        ticks: b.ticks,
        provenance: b.provenance,
      })),
      { pivotLeft: 1, pivotRight: 1 }
    );
    const swings =
      ms.swing_labels.high && ms.swing_labels.low
        ? `${ms.swing_labels.high}/${ms.swing_labels.low}`
        : ms.trend;
    return `${key} ${ms.trend}${swings !== ms.trend ? ` (${swings})` : ''}`;
  };
  return [tag('5m'), tag('15m'), tag('1H'), tag('4H')].join(' · ');
}

function structureTargetPrice(
  bias: 'BUY' | 'SELL',
  bars5m: StructureBar[],
  zoneHigh?: number | null,
  zoneLow?: number | null
): number | null {
  const real = bars5m.filter((b) => isRealBar(b) && !b.forming);
  if (real.length < 6) return null;
  const ms = analyzeMarketStructure(real, { pivotLeft: 1, pivotRight: 1 });
  if (bias === 'BUY') {
    const sh = ms.last_swing_high?.price ?? null;
    // Prefer a target ABOVE the entry zone — zone-high itself is not a trade target.
    if (sh != null && zoneHigh != null && sh <= zoneHigh + 1e-9) {
      const highs = ms.pivots.filter((p) => p.kind === 'HIGH' && p.price > zoneHigh);
      const next = highs[highs.length - 1]?.price ?? null;
      return next;
    }
    return sh != null && (zoneHigh == null || sh > zoneHigh) ? sh : null;
  }
  const sl = ms.last_swing_low?.price ?? null;
  if (sl != null && zoneLow != null && sl >= zoneLow - 1e-9) {
    const lows = ms.pivots.filter((p) => p.kind === 'LOW' && p.price < zoneLow);
    return lows[lows.length - 1]?.price ?? null;
  }
  return sl != null && (zoneLow == null || sl < zoneLow) ? sl : null;
}

export function classifyPriceVsZone(
  price: number,
  low: number,
  high: number,
  padFrac = 0.02
): PriceVsZone {
  const w = Math.max(high - low, 1e-9);
  const pad = w * padFrac;
  if (price < low - pad) return 'BELOW';
  if (price > high + pad) return 'ABOVE';
  return 'IN';
}

function trigger10sStatus(
  bias: 'BUY' | 'SELL' | null,
  bars10s: StructureBar[],
  armed: ArmedTriggerState,
  priceVsZone: PriceVsZone
): string {
  if (!bias) return '—';
  if (priceVsZone === 'ABOVE' || priceVsZone === 'BELOW') {
    return `10s idle · price ${priceVsZone} zone · no micro yet`;
  }
  const real = bars10s.filter((b) => isRealBar(b) && !b.forming);
  const last = real[real.length - 1];
  if (!last) return '10s seeding';
  const dir = last.close >= last.open ? 'UP' : 'DOWN';
  const body = Math.abs(last.close - last.open);
  const wickLow = Math.min(last.open, last.close) - last.low;
  const wickHigh = last.high - Math.max(last.open, last.close);
  const micro =
    armed.confirms.length > 0
      ? armed.confirms.join('+')
      : armed.phase === 'ARMED'
        ? `score ${armed.micro_score}/${MICRO_ENTRY}`
        : 'in band · waiting micro';
  const align =
    (bias === 'BUY' && dir === 'UP') || (bias === 'SELL' && dir === 'DOWN')
      ? 'aligned'
      : 'neutral';
  const wick =
    bias === 'BUY' && wickLow > body
      ? ' · rejection wick'
      : bias === 'SELL' && wickHigh > body
        ? ' · rejection wick'
        : '';
  return `10s ${dir} ${align} · ${micro}${wick}`;
}

function trigger1mStatus(bias: 'BUY' | 'SELL' | null, bars1m: StructureBar[]): string {
  if (!bias) return '—';
  const real = bars1m.filter((b) => isRealBar(b) && !b.forming);
  if (real.length < 4) return '1m seeding';
  const ms = analyzeMarketStructure(real.slice(-30), { pivotLeft: 1, pivotRight: 1 });
  const bull =
    hasEvent(ms, 'RECLAIM', 'BULL') ||
    hasEvent(ms, 'DISPLACEMENT', 'BULL') ||
    hasEvent(ms, 'CHOCH', 'BULL') ||
    hasEvent(ms, 'BOS', 'BULL');
  const bear =
    hasEvent(ms, 'RECLAIM', 'BEAR') ||
    hasEvent(ms, 'DISPLACEMENT', 'BEAR') ||
    hasEvent(ms, 'CHOCH', 'BEAR') ||
    hasEvent(ms, 'BOS', 'BEAR');
  if (bias === 'BUY') {
    if (bull) return `1m BULL shift · ${bull.kind} · ${ms.trend}`;
    if (bear) return `1m against · ${bear.kind} · need reclaim`;
    return `1m ${ms.trend} · waiting micro shift`;
  }
  if (bear) return `1m BEAR shift · ${bear.kind} · ${ms.trend}`;
  if (bull) return `1m against · ${bull.kind} · need rejection`;
  return `1m ${ms.trend} · waiting micro shift`;
}

function waitingForText(opts: {
  ui: EntryPlanUiState;
  armed: ArmedTriggerState;
  bias: 'BUY' | 'SELL' | null;
  price: number;
  zone: { low: number; high: number } | null;
  priceVsZone: PriceVsZone;
}): { waiting_for: string; block_reason: string } {
  const { ui, armed, bias, price, zone, priceVsZone } = opts;
  if (ui === 'INVALIDATED') {
    return {
      waiting_for: armed.detail || 'setup invalidated — watching for fresh zone',
      block_reason: 'INVALIDATED',
    };
  }
  if (ui === 'TRIGGERED') {
    return {
      waiting_for: 'micro confirm met — entry firing',
      block_reason: 'FIRING',
    };
  }
  if (ui === 'ARMED') {
    const need = Math.max(0, MICRO_ENTRY - armed.micro_score);
    if (need > 0) {
      return {
        waiting_for: `IN zone · ARMED · need micro ${armed.micro_score}/${MICRO_ENTRY} (sweep/rejection/reclaim) · zone touch ≠ ENTRY`,
        block_reason: 'NEED_MICRO',
      };
    }
    return {
      waiting_for: `IN zone · micro ok · structural SL / chase checks`,
      block_reason: 'FINAL_CHECKS',
    };
  }
  if (zone && bias && priceVsZone === 'ABOVE') {
    return {
      waiting_for: `NO ENTRY · price ${price.toFixed(2)} ABOVE zone ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} · need pullback into band · then micro ${MICRO_ENTRY}/2 · band ≠ fill`,
      block_reason: 'PRICE_ABOVE_ZONE',
    };
  }
  if (zone && bias && priceVsZone === 'BELOW') {
    return {
      waiting_for: `NO ENTRY · price ${price.toFixed(2)} BELOW zone ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} · need reclaim into band · then micro ${MICRO_ENTRY}/2 · band ≠ fill`,
      block_reason: 'PRICE_BELOW_ZONE',
    };
  }
  if (zone && bias && priceVsZone === 'IN') {
    return {
      waiting_for: `price in zone · arming · waiting micro confirms (zone ≠ ENTRY)`,
      block_reason: 'IN_ZONE_ARMING',
    };
  }
  if (bias) {
    return {
      waiting_for: `locate ${bias} zone · waiting structure location`,
      block_reason: 'LOCATING_ZONE',
    };
  }
  return {
    waiting_for: 'scanning 5m structure for support/resistance',
    block_reason: 'SCANNING',
  };
}

export type BuildEntryPlanInput = {
  price: number | null;
  armed: ArmedTriggerState;
  multiTf?: MultiTfState | null;
  closedBars?: TenSecBar[] | null;
  open_side?: 'BUY' | 'SELL' | null;
  running?: boolean;
};

/** Build display plan from desk snapshot — does not mutate armed state. */
export function buildLiveEntryPlan(input: BuildEntryPlanInput): EntryPlan | null {
  if (input.open_side) return null;
  if (input.running === false) return null;
  if (input.price == null || !Number.isFinite(input.price)) return null;

  const multiTf = input.multiTf;
  const bars5m: StructureBar[] =
    multiTf?.books['5m']?.bars?.map((b) => ({
      open_time_ms: b.open_time_ms,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ticks: b.ticks,
      provenance: b.provenance,
      forming: b.forming,
    })) ?? [];
  const bars1m: StructureBar[] =
    multiTf?.books['1m']?.bars?.map((b) => ({
      open_time_ms: b.open_time_ms,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ticks: b.ticks,
      provenance: b.provenance,
      forming: b.forming,
    })) ?? [];
  const bars10s: StructureBar[] = (input.closedBars ?? []).map((b) => ({
    open_time_ms: b.open_time_ms,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ticks: b.ticks,
    provenance: b.provenance,
  }));

  const htf = multiTf ? buildHtfContextFromBooks(multiTf, input.price) : null;
  const armed = input.armed;
  const ui = mapArmedPhaseToUi(armed.phase);
  const bias = armed.direction;
  const located =
    bias == null
      ? locateEarlyZone({
          now_ms: Date.now(),
          price: input.price,
          bars5m,
          bars1m,
          bars10s,
          htf,
        })
      : null;

  const dir = bias ?? located?.direction ?? null;
  const low = armed.zone_low ?? located?.low ?? null;
  const high = armed.zone_high ?? located?.high ?? null;
  const inv = armed.invalidation ?? located?.invalidation ?? null;
  const entryZone = low != null && high != null ? { low, high } : null;
  const priceVsZone =
    entryZone != null ? classifyPriceVsZone(input.price, entryZone.low, entryZone.high) : null;
  const structPx = dir
    ? structureTargetPrice(dir, bars5m, entryZone?.high ?? null, entryZone?.low ?? null)
    : null;

  const microPreview =
    armed.phase === 'ARMED' && dir && low != null && high != null
      ? scoreMicroConfirmation(armed, {
          now_ms: Date.now(),
          price: input.price,
          bars5m,
          bars1m,
          bars10s,
          htf,
        })
      : null;

  const triggerZone =
    entryZone != null
      ? {
          low: dir === 'BUY' ? entryZone.low : entryZone.low + (entryZone.high - entryZone.low) * 0.5,
          high: dir === 'SELL' ? entryZone.high : entryZone.low + (entryZone.high - entryZone.low) * 0.5,
        }
      : null;

  const effectiveState: EntryPlanUiState =
    ui === 'WATCHING' && dir && armed.phase === 'SETUP' ? 'WATCHING' : ui;

  const wait = waitingForText({
    ui: effectiveState,
    armed,
    bias: dir,
    price: input.price,
    zone: entryZone,
    priceVsZone,
  });

  return {
    state: effectiveState,
    bias: dir,
    entry_zone: entryZone,
    trigger_zone: triggerZone,
    current_price: input.price,
    invalidation: inv,
    structure_target: structPx,
    waiting_for: wait.waiting_for,
    block_reason: wait.block_reason,
    price_vs_zone: priceVsZone,
    trigger_10s: trigger10sStatus(dir, bars10s, armed, priceVsZone),
    trigger_1m: trigger1mStatus(dir, bars1m),
    htf_context: tfTrendLine(multiTf),
    micro_score: microPreview?.score ?? armed.micro_score,
    micro_confirms: microPreview?.kinds ?? armed.confirms,
    detail: armed.detail || located?.detail || htf?.detail || 'scanning',
  };
}

/** Advance armed state on desk tick when flat — keeps UI + machine fresh between 10s buckets. */
export function refreshArmedTriggerState(
  prev: ArmedTriggerState,
  ctx: {
    price: number;
    multiTf: MultiTfState;
    closedBars: TenSecBar[];
    spread?: number | null;
    tick_size?: number | null;
    broker_min_stop?: number | null;
  }
): ArmedTriggerState {
  if (!ctx.multiTf.ready) return prev;
  const bars5m = ctx.multiTf.books['5m'].bars.map((b) => ({
    open_time_ms: b.open_time_ms,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ticks: b.ticks,
    provenance: b.provenance,
    forming: b.forming,
  }));
  const bars1m = ctx.multiTf.books['1m'].bars.map((b) => ({
    open_time_ms: b.open_time_ms,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ticks: b.ticks,
    provenance: b.provenance,
    forming: b.forming,
  }));
  const bars10s = ctx.closedBars.map((b) => ({
    open_time_ms: b.open_time_ms,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ticks: b.ticks,
    provenance: b.provenance,
  }));
  const htf = buildHtfContextFromBooks(ctx.multiTf, ctx.price);
  const { state } = advanceEarlyEntryArmed(prev ?? idleArmedState(), {
    now_ms: Date.now(),
    price: ctx.price,
    bars5m,
    bars1m,
    bars10s,
    htf,
    spread: ctx.spread,
    tick_size: ctx.tick_size,
    broker_min_stop: ctx.broker_min_stop,
  });
  return state;
}
