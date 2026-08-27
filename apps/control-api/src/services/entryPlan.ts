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

export type EntryPlan = {
  state: EntryPlanUiState;
  bias: 'BUY' | 'SELL' | null;
  entry_zone: { low: number; high: number } | null;
  trigger_zone: { low: number; high: number } | null;
  current_price: number | null;
  invalidation: number | null;
  structure_target: number | null;
  waiting_for: string;
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
  bars5m: StructureBar[]
): number | null {
  const real = bars5m.filter((b) => isRealBar(b) && !b.forming);
  if (real.length < 6) return null;
  const ms = analyzeMarketStructure(real, { pivotLeft: 1, pivotRight: 1 });
  if (bias === 'BUY') return ms.last_swing_high?.price ?? null;
  return ms.last_swing_low?.price ?? null;
}

function trigger10sStatus(
  bias: 'BUY' | 'SELL' | null,
  bars10s: StructureBar[],
  armed: ArmedTriggerState
): string {
  if (!bias) return '—';
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
        : 'pending';
  const align =
    (bias === 'BUY' && dir === 'UP') || (bias === 'SELL' && dir === 'DOWN')
      ? 'aligned'
      : 'neutral';
  const wick =
    bias === 'BUY' && wickLow > body ? ' · rejection wick' : bias === 'SELL' && wickHigh > body ? ' · rejection wick' : '';
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

function waitingForText(
  ui: EntryPlanUiState,
  armed: ArmedTriggerState,
  bias: 'BUY' | 'SELL' | null
): string {
  if (ui === 'INVALIDATED') return armed.detail || 'setup invalidated — watching for fresh zone';
  if (ui === 'TRIGGERED') return 'micro confirm met — entry firing';
  if (ui === 'ARMED') {
    const need = Math.max(0, MICRO_ENTRY - armed.micro_score);
    const kinds =
      need > 0
        ? 'sweep_reclaim · rejection · reclaim · micro_shift'
        : armed.confirms.join('+') || 'confirm';
    return `ARMED ${bias ?? ''} · need micro ${need > 0 ? `+${need}` : 'ok'} (${kinds}) · touch≠entry`;
  }
  if (bias) return `locate ${bias} zone · wait price at entry/trigger band`;
  return 'scanning 5m structure for support/resistance';
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
  const structPx = dir ? structureTargetPrice(dir, bars5m) : null;

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

  const entryZone = low != null && high != null ? { low, high } : null;
  const triggerZone =
    entryZone != null
      ? {
          low: dir === 'BUY' ? entryZone.low : entryZone.low + (entryZone.high - entryZone.low) * 0.5,
          high: dir === 'SELL' ? entryZone.high : entryZone.low + (entryZone.high - entryZone.low) * 0.5,
        }
      : null;

  const effectiveState: EntryPlanUiState =
    ui === 'WATCHING' && dir && armed.phase === 'SETUP' ? 'WATCHING' : ui;

  return {
    state: effectiveState,
    bias: dir,
    entry_zone: entryZone,
    trigger_zone: triggerZone,
    current_price: input.price,
    invalidation: inv,
    structure_target: structPx,
    waiting_for: waitingForText(effectiveState, armed, dir),
    trigger_10s: trigger10sStatus(dir, bars10s, armed),
    trigger_1m: trigger1mStatus(dir, bars1m),
    htf_context: tfTrendLine(multiTf),
    micro_score: microPreview?.score ?? armed.micro_score,
    micro_confirms: microPreview?.kinds ?? armed.confirms,
    detail: armed.detail || located?.detail || htf?.detail || 'scanning',
  };
}

/** Advance armed state on desk tick when flat — keeps UI + machine fresh between 10s buckets.
 * MUST NOT consume TRIGGERED: a prior UI refresh that fires+discards the signal causes the next
 * advanceEarlyEntryArmed() to reset TRIGGERED→SETUP and the fill never reaches enterTrade.
 * Cap at ARMED (preserve micro score) so decideEntryFrom10sRegime can still emit the signal.
 */
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
  const { state, signal } = advanceEarlyEntryArmed(prev ?? idleArmedState(), {
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
  return holdTriggeredForDecidePath(state, signal);
}

/**
 * UI refresh must not leave phase=TRIGGERED — advanceEarlyEntryArmed resets
 * TRIGGERED→SETUP on the next call, which drops the fire before enterTrade.
 */
export function holdTriggeredForDecidePath(
  state: ArmedTriggerState,
  signal: { direction: 'BUY' | 'SELL' } | null
): ArmedTriggerState {
  if (signal != null || state.phase === 'TRIGGERED') {
    return {
      ...state,
      phase: 'ARMED',
      detail: `ARMED · pending execution · micro ${state.micro_score}/2 · ${state.confirms.join('+') || 'ready'}`,
    };
  }
  return state;
}

/** Exact block line for ARMED ticks that did not reach enterTrade. */
export function formatArmedTriggerDiag(
  armed: ArmedTriggerState,
  price: number | null | undefined
): string {
  const z =
    armed.zone_low != null && armed.zone_high != null
      ? `${armed.zone_low.toFixed(2)}–${armed.zone_high.toFixed(2)}`
      : '—';
  const px = price != null && Number.isFinite(price) ? price.toFixed(2) : '—';
  let vs = '';
  if (price != null && Number.isFinite(price) && armed.zone_low != null && armed.zone_high != null) {
    if (price > armed.zone_high) vs = 'ABOVE';
    else if (price < armed.zone_low) vs = 'BELOW';
    else vs = 'IN';
  }
  const need = Math.max(0, 2 - (armed.micro_score || 0));
  let why = armed.detail || armed.phase;
  if (armed.phase === 'ARMED' && need > 0) {
    why = `NEED_MICRO ${armed.micro_score}/2 (need +${need}) · touch≠ENTRY`;
  } else if (armed.phase === 'ARMED' && need === 0) {
    why = `MICRO_OK · awaiting decideEntry→ORDER path · ${armed.detail}`;
  } else if (armed.phase === 'SETUP' || armed.phase === 'IDLE') {
    why = `NOT_ARMED · ${armed.phase} · wait price in zone`;
  } else if (armed.phase === 'INVALIDATED') {
    why = `INVALIDATED · ${armed.detail}`;
  }
  return `ARMED_DIAG · ${armed.phase} · ${armed.direction ?? 'FLAT'} · px ${px} ${vs} zone ${z} · micro ${armed.micro_score}/2 · ${why}`;
}
