/**
 * Anti-whipsaw gate — micro Gold was doing ~9 trades / 6 min (HardInv → 45s → flip).
 * Shared per epic so multi-unit desks don't stack the same chop.
 */

export type ExitSide = 'BUY' | 'SELL';

type EpicCooldown = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byEpic = new Map<string, EpicCooldown>();

/** After any close — short pause only (was 10–15m filter pile). */
export const EPIC_PAUSE_MS = 180_000; // 3 min
export const EPIC_LOSS_PAUSE_MS = 300_000; // 5 min
export const EPIC_FLIP_BLOCK_MS = 300_000; // 5 min

function key(epic: string): string {
  return String(epic || '')
    .trim()
    .toUpperCase();
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
  const pause = g.wasLoss ? EPIC_LOSS_PAUSE_MS : EPIC_PAUSE_MS;
  if (ago < pause) {
    return {
      ok: false,
      reason: `EPIC pause ${Math.ceil((pause - ago) / 1000)}s · ${
        g.wasLoss ? 'after loss' : 'after close'
      } · no whipsaw`,
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

/** Test helper */
export function resetEpicTradeCooldowns(): void {
  byEpic.clear();
}
