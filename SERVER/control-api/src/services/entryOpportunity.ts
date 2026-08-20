/**
 * Opportunity score — explainable, but hard blocks always win.
 */

import type { EntryPlan } from './regimeEntryPlan.js';
import type { TickMicroMetrics } from './tickMicroEngine.js';
import type {
  EntryKind,
  EntryLocationView,
  MovementPhase,
} from './entryStateMachine.js';

export type OpportunityBreakdown = {
  structure: number;
  location: number;
  phase: number;
  momentum: number;
  acceleration: number;
  persistence: number;
  tick_activity: number;
  spread: number;
  feed_agreement: number;
  extension: number;
  exhaustion_noise: number;
  total: number;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function computeOpportunityScore(input: {
  plan: EntryPlan;
  micro: TickMicroMetrics;
  location: EntryLocationView;
  phase: MovementPhase;
  kind: EntryKind;
  side: 'BUY' | 'SELL' | null;
  feedAgreement?: string | null;
}): OpportunityBreakdown {
  const { plan, micro, location, phase, side } = input;
  const structure = clamp01(
    (plan.confirm_ok || 0) / Math.max(plan.confirm_n || 1, 1)
  );

  let locScore = 0.4;
  if (location.near_entry) locScore = 0.9;
  if (location.past_invalidation) locScore = 0;
  if ((location.dist_to_entry_atr ?? 99) > 2) locScore = Math.min(locScore, 0.25);

  const phaseScore: Record<MovementPhase, number> = {
    BASE: 0.2,
    PRESSURE: 0.55,
    IGNITION: 0.95,
    EARLY_EXPANSION: 0.85,
    MATURE: 0.25,
    EXHAUSTION: 0.05,
    PULLBACK: 0.7,
    RELOAD: 0.8,
    FAILED_MOVE: 0.1,
  };

  const withSide = side === 'BUY' ? 1 : side === 'SELL' ? -1 : 0;
  const vel = (micro.velocity_1s ?? 0) * withSide;
  const momentum = clamp01(0.5 + vel * 8000);
  const accel = (micro.acceleration ?? 0) * withSide;
  const acceleration = clamp01(0.5 + accel * 12000);
  const persist = (micro.direction_persistence ?? 0) * withSide;
  const persistence = clamp01(0.5 + persist * 0.5);
  const tick_activity = clamp01(
    micro.tick_burst ? 0.95 : Math.min(1, micro.tick_rate_1s / 6)
  );

  let spread = 0.7;
  if (micro.spread != null && micro.last_mid != null && micro.last_mid > 0) {
    const rel = micro.spread / micro.last_mid;
    spread = clamp01(1 - rel / 0.0004);
  }
  if ((micro.spread_delta_2s ?? 0) > 0 && micro.last_mid) {
    spread = Math.min(spread, 0.45);
  }

  const agr = String(input.feedAgreement || '').toUpperCase();
  const feed_agreement =
    agr === 'TIGHT' || agr === 'OK' || agr === 'AGREE' || agr === 'ALIGNED'
      ? 0.9
      : agr === 'DIVERGENT' || agr === 'FIGHT'
        ? 0.15
        : agr === 'INSUFFICIENT' || agr === 'NONE'
          ? 0.35
          : 0.55;

  const ext = location.extension_atr ?? 0;
  const extension = clamp01(1 - Math.max(0, ext - 0.5) / 3);

  let exhaustion_noise = 0.8;
  if (side === 'BUY' && micro.exhaustion_up) exhaustion_noise = 0.05;
  if (side === 'SELL' && micro.exhaustion_down) exhaustion_noise = 0.05;
  if ((micro.reversal_rate_5s ?? 0) > 0.5) exhaustion_noise = Math.min(exhaustion_noise, 0.3);

  const parts = {
    structure,
    location: locScore,
    phase: phaseScore[phase],
    momentum,
    acceleration,
    persistence,
    tick_activity,
    spread,
    feed_agreement,
    extension,
    exhaustion_noise,
  };

  const weights: Record<keyof typeof parts, number> = {
    structure: 0.12,
    location: 0.14,
    phase: 0.12,
    momentum: 0.1,
    acceleration: 0.1,
    persistence: 0.08,
    tick_activity: 0.08,
    spread: 0.08,
    feed_agreement: 0.08,
    extension: 0.05,
    exhaustion_noise: 0.05,
  };

  let total = 0;
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) {
    total += parts[k] * weights[k];
  }

  return { ...parts, total: clamp01(total) };
}
