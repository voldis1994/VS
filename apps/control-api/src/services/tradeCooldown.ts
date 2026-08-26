/**
 * Anti-whipsaw after close.
 * Must flip side — never 5× identical same-side orders.
 * Short pause then only opposite direction allowed.
 */

export type ExitSide = 'BUY' | 'SELL';

type EpicCooldown = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byEpic = new Map<string, EpicCooldown>();

/** Brief cool-off after any close before opposite entry. */
export const EPIC_PAUSE_MS = 15_000; // 15s
/** After loss/scratch — slightly longer before flip entry. */
export const EPIC_LOSS_PAUSE_MS = 20_000; // 20s
/** @deprecated flip is required; kept for tests/compat */
export const EPIC_FLIP_BLOCK_MS = 0;
/** Same side never repeats until opposite trade closes. */
export const EPIC_SAME_SIDE_BLOCK_MS = Number.POSITIVE_INFINITY;

function key(epic: string): string {
  return String(epic || '')
    .trim()
    .toUpperCase();
}

export function pauseMsAfterClose(wasLoss: boolean): number {
  return wasLoss ? EPIC_LOSS_PAUSE_MS : EPIC_PAUSE_MS;
}

export function noteEpicTradeClose(
  epic: string,
  side: ExitSide | null | undefined,
  wasLoss: boolean
): void {
  const k = key(epic);
  if (!k) return;
  byEpic.set(k, {
    closedAtMs: Date.now(),
    side: side === 'BUY' || side === 'SELL' ? side : null,
    wasLoss,
  });
}

export function allowEpicReentry(
  epic: string,
  direction: ExitSide
): { ok: boolean; reason: string } {
  const g = byEpic.get(key(epic));
  if (!g || !g.closedAtMs) return { ok: true, reason: 'no recent epic close' };
  const ago = Date.now() - g.closedAtMs;
  const pause = pauseMsAfterClose(g.wasLoss);
  if (ago < pause) {
    return {
      ok: false,
      reason: `EPIC pause ${Math.ceil((pause - ago) / 1000)}s · ${
        g.wasLoss ? 'after loss/scratch' : 'after profit'
      } · wait flip`,
    };
  }
  // Must flip — last BUY → only SELL next (stops 5× identical orders)
  if (g.side && g.side === direction) {
    return {
      ok: false,
      reason: `EPIC must flip · last ${g.side} · no same-side reopen`,
    };
  }
  return { ok: true, reason: 'epic cool · flip ok' };
}

/** Lookup last close for desk POST-CLOSE (same epic). */
export function lastEpicClose(
  epic: string
): { closedAtMs: number; wasLoss: boolean; side: ExitSide | null } | null {
  const g = byEpic.get(key(epic));
  if (!g?.closedAtMs) return null;
  return { closedAtMs: g.closedAtMs, wasLoss: g.wasLoss, side: g.side };
}

/** Test helper */
export function resetEpicTradeCooldowns(): void {
  byEpic.clear();
}
