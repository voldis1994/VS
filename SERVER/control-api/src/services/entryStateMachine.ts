/**
 * Entry state machine + movement phase.
 * Regime/plan = context. EntryReady only after micro trigger + location + not late.
 * State persists per instrument — never reset every robotDesk cycle.
 */

import type { EntryPlan, EntryPlanTarget } from './regimeEntryPlan.js';
import {
  estimateMoveStartMid,
  getTickMicroBook,
  significantVelocity,
  signedSignificant,
  type TickMicroMetrics,
} from './tickMicroEngine.js';

export type EntryEngineMode = 'OFF' | 'SHADOW' | 'PAPER' | 'LIVE';

export type EntryStateName =
  | 'NO_PLAN'
  | 'WATCHING'
  | 'ARMED'
  | 'TRIGGERING'
  | 'ENTRY_READY'
  | 'TOO_LATE'
  | 'INVALIDATED'
  | 'COOLDOWN';

export type MovementPhase =
  | 'BASE'
  | 'PRESSURE'
  | 'IGNITION'
  | 'EARLY_EXPANSION'
  | 'MATURE'
  | 'EXHAUSTION'
  | 'PULLBACK'
  | 'RELOAD'
  | 'FAILED_MOVE';

export type EntryKind =
  | 'IGNITION_ENTRY'
  | 'FIRST_PULLBACK'
  | 'BREAKOUT_RETEST'
  | 'RANGE_REJECTION'
  | 'FAILED_BREAKOUT'
  | 'CONTINUATION_RELOAD'
  | null;

export type LateReason = 'TOO_LATE' | 'OVEREXTENDED' | 'MISSED_ENTRY' | null;

export type EntryLocationView = {
  entry: number | null;
  invalidation: number | null;
  range_high: number | null;
  range_low: number | null;
  break_level: number | null;
  confirm_level: number | null;
  /** Signed: + toward favorable for side; distance / local vol */
  dist_to_entry_atr: number | null;
  /** How far price has already run from entry zone (ATR units) */
  extension_atr: number | null;
  near_entry: boolean;
  past_invalidation: boolean;
};

export type EntryMachineSnapshot = {
  instrument: string;
  mode: EntryEngineMode;
  state: EntryStateName;
  phase: MovementPhase;
  kind: EntryKind;
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  late_reason: LateReason;
  location: EntryLocationView;
  opportunity_score: number | null;
  hard_block: string | null;
  reason: string;
  updated_at_ms: number;
  cooldown_until_ms: number;
  /** Anchor mid when plan first armed — for extension / missed */
  plan_anchor_mid: number | null;
  /** First ignition mid — movement start */
  move_start_mid: number | null;
};

const COOLDOWN_MS = 20_000;
const machines = new Map<string, EntryMachineSnapshot>();

export function getEntryEngineMode(): EntryEngineMode {
  const raw = String(process.env.VS_ENTRY_ENGINE_MODE || 'SHADOW')
    .trim()
    .toUpperCase();
  if (raw === 'OFF' || raw === 'SHADOW' || raw === 'PAPER' || raw === 'LIVE') return raw;
  return 'SHADOW';
}

export function emptyLocation(targets?: EntryPlanTarget | null): EntryLocationView {
  return {
    entry: targets?.entry ?? null,
    invalidation: targets?.invalidation ?? null,
    range_high: targets?.range_high ?? null,
    range_low: targets?.range_low ?? null,
    break_level: targets?.break_level ?? null,
    confirm_level: targets?.confirm_level ?? null,
    dist_to_entry_atr: null,
    extension_atr: null,
    near_entry: false,
    past_invalidation: false,
  };
}

export function defaultMachine(instrument: string, mode = getEntryEngineMode()): EntryMachineSnapshot {
  return {
    instrument: String(instrument || '').toUpperCase(),
    mode,
    state: 'NO_PLAN',
    phase: 'BASE',
    kind: null,
    direction: null,
    setup: null,
    late_reason: null,
    location: emptyLocation(),
    opportunity_score: null,
    hard_block: null,
    reason: 'init',
    updated_at_ms: Date.now(),
    cooldown_until_ms: 0,
    plan_anchor_mid: null,
    move_start_mid: null,
  };
}

export function getEntryMachine(instrument: string): EntryMachineSnapshot {
  const key = String(instrument || '').toUpperCase();
  let m = machines.get(key);
  if (!m) {
    m = defaultMachine(key);
    machines.set(key, m);
  }
  m.mode = getEntryEngineMode();
  return m;
}

/** Local volatility proxy from micro + optional ATR-like from plan span. */
export function localVol(
  micro: TickMicroMetrics,
  targets: EntryPlanTarget | null | undefined,
  mid: number
): number {
  const abs = Math.max(Math.abs(mid), 1e-9);
  const microVol = micro.micro_volatility_5s != null ? micro.micro_volatility_5s * abs : null;
  const span =
    targets?.range_high != null && targets?.range_low != null
      ? Math.max(targets.range_high - targets.range_low, 0)
      : null;
  const fromSpan = span != null && span > 0 ? span * 0.15 : null;
  const floor = abs >= 1000 ? 0.4 : abs * 0.00015;
  return Math.max(microVol ?? 0, fromSpan ?? 0, floor);
}

export function computeLocation(
  side: 'BUY' | 'SELL' | null,
  mid: number | null,
  targets: EntryPlanTarget | null | undefined,
  micro: TickMicroMetrics,
  moveStart: number | null
): EntryLocationView {
  const loc = emptyLocation(targets);
  if (mid == null || !Number.isFinite(mid) || !side) return loc;
  const vol = localVol(micro, targets, mid);
  const entry = targets?.entry ?? null;
  if (entry != null && Number.isFinite(entry)) {
    const raw = side === 'BUY' ? mid - entry : entry - mid;
    loc.dist_to_entry_atr = raw / vol;
    loc.near_entry = Math.abs(mid - entry) <= vol * 1.25;
  } else {
    loc.near_entry = true; // no explicit entry → location soft
  }
  const inv = targets?.invalidation ?? null;
  if (inv != null && Number.isFinite(inv)) {
    loc.past_invalidation = side === 'BUY' ? mid < inv : mid > inv;
  }
  const anchor = moveStart ?? entry ?? mid;
  const run = side === 'BUY' ? mid - anchor : anchor - mid;
  loc.extension_atr = run / vol;
  return loc;
}

export function classifyMovementPhase(input: {
  micro: TickMicroMetrics;
  location: EntryLocationView;
  side: 'BUY' | 'SELL' | null;
  prev: MovementPhase;
}): MovementPhase {
  const { micro, location, side, prev } = input;
  if (!side) return 'BASE';
  if (micro.exhaustion_up && side === 'BUY') return 'EXHAUSTION';
  if (micro.exhaustion_down && side === 'SELL') return 'EXHAUSTION';

  const persist = micro.direction_persistence ?? 0;
  const withSide = side === 'BUY' ? 1 : -1;
  const signedPersist = persist * withSide;
  const signedVel1 = (micro.velocity_1s ?? 0) * withSide;
  const signedVel5 = (micro.velocity_5s ?? 0) * withSide;
  const signedAccel = (micro.acceleration ?? 0) * withSide;
  const ext = location.extension_atr ?? 0;
  const vol = Math.max(micro.micro_volatility_5s ?? 0, 1e-7);

  if (ext > 3.5 && signedVel1 > 0) return 'MATURE';
  if (ext > 2.2 && signedAccel < -(vol * 0.3)) return 'EXHAUSTION';

  if (
    (prev === 'EARLY_EXPANSION' || prev === 'MATURE' || prev === 'IGNITION') &&
    signedVel1 < -(vol * 0.5) &&
    signedPersist < 0.1
  ) {
    return 'PULLBACK';
  }
  if (prev === 'PULLBACK' && signedVel1 > vol * 0.5 && signedPersist > 0.2) return 'RELOAD';

  if (micro.tick_burst && signedAccel > 0 && signedSignificant(micro.velocity_1s, side, micro, 0.8)) {
    return 'IGNITION';
  }
  if (signedVel1 > vol * 0.9 && signedPersist > 0.35 && ext < 2.0) return 'EARLY_EXPANSION';
  if (signedPersist > 0.15 && significantVelocity(micro.velocity_5s, micro, 0.5)) return 'PRESSURE';
  if (ext < 0 && Math.abs(ext) > 1.5) return 'FAILED_MOVE';
  if (micro.stalling && Math.abs(persist) < 0.15) return 'BASE';
  void signedVel5;
  return prev === 'BASE' || prev === 'FAILED_MOVE' ? 'BASE' : prev;
}

export function resolveEntryKind(
  setup: string | null | undefined,
  phase: MovementPhase,
  regime: string | null | undefined
): EntryKind {
  const s = String(setup || '').toUpperCase();
  const r = String(regime || '').toUpperCase();
  if (s === 'FAILED_BREAKOUT' || r.includes('FAILED_BREAKOUT')) return 'FAILED_BREAKOUT';
  if (s === 'RANGE_REJECTION' || r === 'RANGE') return 'RANGE_REJECTION';
  if (s === 'BREAKOUT' || r.includes('BREAKOUT')) {
    return phase === 'PULLBACK' || phase === 'RELOAD' ? 'BREAKOUT_RETEST' : 'IGNITION_ENTRY';
  }
  if (s === 'PULLBACK' || phase === 'PULLBACK' || phase === 'RELOAD') {
    return phase === 'RELOAD' ? 'CONTINUATION_RELOAD' : 'FIRST_PULLBACK';
  }
  if (s === 'CONTINUATION') {
    return phase === 'IGNITION' || phase === 'EARLY_EXPANSION'
      ? 'IGNITION_ENTRY'
      : 'CONTINUATION_RELOAD';
  }
  if (phase === 'IGNITION' || phase === 'EARLY_EXPANSION') return 'IGNITION_ENTRY';
  return s ? 'CONTINUATION_RELOAD' : null;
}

export function evaluateLate(input: {
  location: EntryLocationView;
  phase: MovementPhase;
  micro: TickMicroMetrics;
  side: 'BUY' | 'SELL';
}): LateReason {
  const ext = input.location.extension_atr ?? 0;
  if (ext >= 3.0) return 'OVEREXTENDED';
  if (
    input.phase === 'MATURE' ||
    input.phase === 'EXHAUSTION' ||
    (ext >= 2.0 && (input.micro.acceleration ?? 0) * (input.side === 'BUY' ? 1 : -1) < 0)
  ) {
    return 'TOO_LATE';
  }
  if (!input.location.near_entry && ext > 1.5) return 'MISSED_ENTRY';
  return null;
}

function microSupportsSide(side: 'BUY' | 'SELL', micro: TickMicroMetrics): boolean {
  const persist = micro.direction_persistence ?? 0;
  if (side === 'BUY') {
    if (micro.exhaustion_up) return false;
    return (
      signedSignificant(micro.velocity_1s, 'BUY', micro, 0.6) ||
      persist > 0.2 ||
      micro.tick_burst
    );
  }
  if (micro.exhaustion_down) return false;
  return (
    signedSignificant(micro.velocity_1s, 'SELL', micro, 0.6) ||
    persist < -0.2 ||
    micro.tick_burst
  );
}

function triggerForKind(
  kind: EntryKind,
  phase: MovementPhase,
  location: EntryLocationView,
  micro: TickMicroMetrics,
  side: 'BUY' | 'SELL'
): boolean {
  if (!kind) return false;
  if (location.past_invalidation) return false;
  if (!microSupportsSide(side, micro)) return false;
  switch (kind) {
    case 'IGNITION_ENTRY':
      return (
        (phase === 'IGNITION' || phase === 'EARLY_EXPANSION' || phase === 'PRESSURE') &&
        (micro.tick_burst || signedSignificant(micro.acceleration, side, micro, 0.4))
      );
    case 'FIRST_PULLBACK':
      return (
        (phase === 'PULLBACK' || phase === 'RELOAD') &&
        location.near_entry &&
        microSupportsSide(side, micro)
      );
    case 'BREAKOUT_RETEST':
      return location.near_entry && (phase === 'PULLBACK' || phase === 'RELOAD' || phase === 'PRESSURE');
    case 'RANGE_REJECTION':
      return location.near_entry && phase !== 'MATURE' && phase !== 'EXHAUSTION';
    case 'FAILED_BREAKOUT':
      return microSupportsSide(side, micro) && phase !== 'EXHAUSTION';
    case 'CONTINUATION_RELOAD':
      return phase === 'RELOAD' || (phase === 'EARLY_EXPANSION' && location.near_entry);
    default:
      return false;
  }
}

export type AdvanceInput = {
  instrument: string;
  plan: EntryPlan;
  mid: number | null;
  micro: TickMicroMetrics;
  regime?: string | null;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
  nowMs?: number;
};

/**
 * Advance persistent machine from plan + micro. Does not place orders.
 */
export function advanceEntryMachine(input: AdvanceInput): EntryMachineSnapshot {
  const now = input.nowMs ?? Date.now();
  const m = getEntryMachine(input.instrument);
  m.mode = getEntryEngineMode();
  m.updated_at_ms = now;

  if (m.state === 'COOLDOWN' && now < m.cooldown_until_ms) {
    m.reason = `COOLDOWN ${Math.ceil((m.cooldown_until_ms - now) / 1000)}s`;
    return m;
  }
  if (m.state === 'COOLDOWN' && now >= m.cooldown_until_ms) {
    m.state = 'NO_PLAN';
    m.reason = 'cooldown ended';
  }

  if (input.marketOpen === false) {
    m.hard_block = 'MARKET_CLOSED';
    m.state = m.state === 'ENTRY_READY' ? 'INVALIDATED' : m.state;
    m.reason = 'market closed';
    return m;
  }
  if (input.spreadBlock) {
    m.hard_block = 'SPREAD_BLOCK';
    m.reason = 'spread block';
    if (m.state === 'TRIGGERING' || m.state === 'ENTRY_READY') m.state = 'INVALIDATED';
    return m;
  }

  const plan = input.plan;
  const side = plan.direction;
  if (!side || !plan.setup) {
    m.state = 'NO_PLAN';
    m.direction = null;
    m.setup = null;
    m.kind = null;
    m.phase = 'BASE';
    m.hard_block = null;
    m.late_reason = null;
    m.location = emptyLocation(plan.targets);
    m.opportunity_score = null;
    m.plan_anchor_mid = null;
    m.move_start_mid = null;
    m.reason = 'no plan direction/setup';
    return m;
  }

  // FIGHT is hard block for entry
  if (plan.feed_confirm === 'FIGHT') {
    m.hard_block = 'FEED_FIGHT';
    m.direction = side;
    m.setup = plan.setup;
    if (m.state === 'ARMED' || m.state === 'TRIGGERING' || m.state === 'ENTRY_READY') {
      m.state = 'INVALIDATED';
    } else if (m.state === 'NO_PLAN') {
      m.state = 'WATCHING';
    }
    m.reason = 'feeds FIGHT — not EntryReady';
    return m;
  }

  m.hard_block = null;
  m.direction = side;
  m.setup = plan.setup;
  if (m.plan_anchor_mid == null && input.mid != null) m.plan_anchor_mid = input.mid;

  // Impulse origin: from tick log / setup level BEFORE phase labels IGNITION at current mid.
  // Prefer break/entry target, else estimate from micro tick path (earliest run start).
  if (m.move_start_mid == null) {
    const setupOrigin =
      plan.targets.break_level ?? plan.targets.entry ?? plan.targets.confirm_level ?? null;
    const rising =
      signedSignificant(input.micro.velocity_1s, side, input.micro, 0.7) ||
      input.micro.tick_burst ||
      (input.micro.direction_persistence ?? 0) * (side === 'BUY' ? 1 : -1) > 0.25;
    if (rising) {
      const fromTicks = estimateMoveStartMid(getTickMicroBook(input.instrument), side, now);
      m.move_start_mid =
        setupOrigin != null && Number.isFinite(setupOrigin) ? setupOrigin : fromTicks;
    }
  }

  m.location = computeLocation(side, input.mid, plan.targets, input.micro, m.move_start_mid);
  const prevPhase = m.phase;
  m.phase = classifyMovementPhase({
    micro: input.micro,
    location: m.location,
    side,
    prev: prevPhase,
  });

  // If we just entered PRESSURE/IGNITION without origin, backfill from ticks — never current mid.
  if (
    m.move_start_mid == null &&
    (m.phase === 'PRESSURE' || m.phase === 'IGNITION' || m.phase === 'EARLY_EXPANSION')
  ) {
    m.move_start_mid =
      plan.targets.break_level ??
      plan.targets.entry ??
      estimateMoveStartMid(getTickMicroBook(input.instrument), side, now);
    m.location = computeLocation(side, input.mid, plan.targets, input.micro, m.move_start_mid);
  }

  m.kind = resolveEntryKind(plan.setup, m.phase, input.regime);
  const late = evaluateLate({
    location: m.location,
    phase: m.phase,
    micro: input.micro,
    side,
  });
  m.late_reason = late;

  if (m.location.past_invalidation) {
    m.state = 'INVALIDATED';
    m.reason = 'price past invalidation';
    m.cooldown_until_ms = now + COOLDOWN_MS;
    return m;
  }

  if (late) {
    m.state = 'TOO_LATE';
    m.reason = late;
    return m;
  }

  // Structure plan watching → armed when confirms mostly ok (but FEEDS must be ok)
  const confirmsOk = plan.confirms.filter((c) => c.ok).length;
  const confirmsN = plan.confirms.length;
  const structureReady = confirmsN > 0 && confirmsOk >= confirmsN;

  if (m.state === 'NO_PLAN' || m.state === 'INVALIDATED' || m.state === 'TOO_LATE') {
    m.state = 'WATCHING';
    m.reason = `WATCHING ${side} ${plan.setup}`;
  }

  if (m.state === 'WATCHING' && structureReady) {
    m.state = 'ARMED';
    m.reason = `ARMED ${confirmsOk}/${confirmsN}`;
  }

  if (m.state === 'ARMED' || m.state === 'TRIGGERING') {
    const fired = triggerForKind(m.kind, m.phase, m.location, input.micro, side);
    if (fired) {
      m.state = 'TRIGGERING';
      m.reason = `TRIGGER ${m.kind} · ${m.phase}`;
      // ENTRY_READY only after trigger + not late + location ok
      if (m.location.near_entry || m.kind === 'IGNITION_ENTRY' || m.kind === 'FAILED_BREAKOUT') {
        m.state = 'ENTRY_READY';
        m.reason = `ENTRY_READY ${m.kind} · ${m.phase} · loc ok`;
      }
    } else {
      m.state = 'ARMED';
      m.reason = `ARMED wait trigger · ${m.phase}`;
    }
  }

  return m;
}

export function markEntryConsumed(instrument: string, nowMs = Date.now()): void {
  const m = getEntryMachine(instrument);
  m.state = 'COOLDOWN';
  m.cooldown_until_ms = nowMs + COOLDOWN_MS;
  m.reason = 'entry consumed → COOLDOWN';
  m.move_start_mid = null;
  m.plan_anchor_mid = null;
}

export function resetEntryMachines(): void {
  machines.clear();
}
