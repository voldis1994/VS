/**
 * Anti-whipsaw gate after close.
 * Stops £0 “nules” → instant same-side reopen spam.
 * Profit → 45s · Scratch/Loss → 60s · same-side block 60s.
 */

export type ExitSide = 'BUY' | 'SELL';

type EpicCooldown = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byEpic = new Map<string, EpicCooldown>();

/** After real profit close. */
export const EPIC_PAUSE_MS = 45_000; // 45s
/** After loss OR scratch (£0) close. */
export const EPIC_LOSS_PAUSE_MS = 60_000; // 60s
/** Block opposite flip. */
export const EPIC_FLIP_BLOCK_MS = 60_000; // 60s
/** Block reopening the SAME side — user: “ver to pašu treidu vaļā”. */
export const EPIC_SAME_SIDE_BLOCK_MS = 60_000; // 60s

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
      } · no whipsaw`,
    };
  }
  if (g.side && g.side === direction && ago < EPIC_SAME_SIDE_BLOCK_MS) {
    return {
      ok: false,
      reason: `EPIC no-repeat · last ${g.side} · block same ${Math.ceil(
        (EPIC_SAME_SIDE_BLOCK_MS - ago) / 1000
      )}s`,
    };
  }
  if (g.side && g.side !== direction && ago < EPIC_FLIP_BLOCK_MS) {
    return {
      ok: false,
      reason: `EPIC no-flip · last ${g.side} · block ${direction} ${Math.ceil(
        (EPIC_FLIP_BLOCK_MS - ago) / 1000
      )}s`,
    };
  }
  return { ok: true, reason: 'epic cool' };
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
