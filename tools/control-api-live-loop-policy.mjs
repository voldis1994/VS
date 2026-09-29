/**
 * Restart policy for control-api-live-loop.
 * Exit 75 = BRAIN .ts reload (immediate restart).
 * Any other non-zero crash must ALSO restart — otherwise the desk shows
 * permanent "Failed to fetch" until the user re-runs VS.bat.
 */

export const BRAIN_RELOAD_EXIT_CODE = 75;

/** Max unexpected crashes inside the rolling window before giving up. */
export const MAX_CRASH_BURST = 8;

/** Rolling window for crash burst detection (ms). */
export const CRASH_WINDOW_MS = 120_000;

/** Backoff after unexpected exit (ms), indexed by crash count in window. */
export const CRASH_BACKOFF_MS = [1_500, 3_000, 5_000, 10_000, 20_000, 30_000];

/**
 * @param {{ code: number, signal: string | null }} result
 * @returns {'brain_reload' | 'clean_stop' | 'signal_stop' | 'crash_restart'}
 */
export function classifyLiveLoopExit(result) {
  const code = result.code == null ? 1 : result.code;
  const signal = result.signal || null;
  if (code === BRAIN_RELOAD_EXIT_CODE) return 'brain_reload';
  if (signal === 'SIGINT' || signal === 'SIGTERM') return 'signal_stop';
  if (code === 0 && !signal) return 'clean_stop';
  return 'crash_restart';
}

/**
 * @param {number[]} crashTimesMs prior crash timestamps (mutated copy returned)
 * @param {number} nowMs
 * @returns {{ giveUp: boolean, delayMs: number, crashTimesMs: number[], crashesInWindow: number }}
 */
export function planCrashRestart(crashTimesMs, nowMs = Date.now()) {
  const fresh = crashTimesMs.filter((t) => nowMs - t < CRASH_WINDOW_MS);
  fresh.push(nowMs);
  const crashesInWindow = fresh.length;
  const giveUp = crashesInWindow >= MAX_CRASH_BURST;
  const idx = Math.min(crashesInWindow - 1, CRASH_BACKOFF_MS.length - 1);
  return {
    giveUp,
    delayMs: giveUp ? 0 : CRASH_BACKOFF_MS[idx],
    crashTimesMs: fresh,
    crashesInWindow,
  };
}
