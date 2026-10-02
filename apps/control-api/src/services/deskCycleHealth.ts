/**
 * Desk cycle health for UI banners — shared thresholds so multi-account
 * Capital lock queue is not painted as a hang.
 */
export type DeskCycleHealth =
  | { level: 'ok' }
  | { level: 'warn'; age_s: number; kind: 'capital_busy' }
  | { level: 'stuck'; age_s: number }
  | { level: 'stale_log'; age_s: number };

export const DESK_CYCLE_BUSY_WARN_MS = 15_000;
export const DESK_CYCLE_BUSY_STUCK_MS = 40_000;
export const DESK_LIVE_LOG_STALE_MS = 45_000;

export function deskCycleHealth(input: {
  running: boolean;
  cycle_busy?: boolean;
  cycle_busy_age_ms?: number;
  last_activity_at?: string | null;
  last_tick_at?: string | null;
  last_quote_at?: string | null;
  now?: number;
}): DeskCycleHealth {
  if (!input.running) return { level: 'ok' };
  const busyAge = input.cycle_busy ? input.cycle_busy_age_ms || 0 : 0;
  if (input.cycle_busy && busyAge >= DESK_CYCLE_BUSY_STUCK_MS) {
    return { level: 'stuck', age_s: Math.round(busyAge / 1000) };
  }
  if (input.cycle_busy && busyAge >= DESK_CYCLE_BUSY_WARN_MS) {
    return { level: 'warn', age_s: Math.round(busyAge / 1000), kind: 'capital_busy' };
  }
  // LIVE LOG pauses while cycle_busy — never double-alarm
  if (input.cycle_busy) return { level: 'ok' };

  const iso = input.last_activity_at || input.last_tick_at || input.last_quote_at;
  if (!iso) return { level: 'ok' };
  const now = input.now ?? Date.now();
  const age = now - new Date(iso).getTime();
  if (!Number.isFinite(age) || age <= DESK_LIVE_LOG_STALE_MS) return { level: 'ok' };
  return { level: 'stale_log', age_s: Math.round(age / 1000) };
}
