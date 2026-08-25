/**
 * Same-epic multi-client entry sync.
 * When one unit opens on a closed 5m bar, peers on the same epic follow
 * that signal instead of waiting for their own candle-close edge.
 */

export type EpicEntrySide = "BUY" | "SELL";

export type EpicEntrySignal = {
  epic: string;
  side: EpicEntrySide;
  regime: string;
  barBucketMs: number;
  mid: number;
  atMs: number;
  sourceUnitId: string;
};

/** Follow window: peers should enter in the same 5m bucket (~4 min left). */
export const EPIC_ENTRY_TTL_MS = 4 * 60_000;

const byEpic = new Map<string, EpicEntrySignal>();

export function publishEpicEntry(signal: EpicEntrySignal): void {
  const epic = String(signal.epic ?? "").trim().toUpperCase();
  if (!epic || (signal.side !== "BUY" && signal.side !== "SELL")) return;
  byEpic.set(epic, {
    ...signal,
    epic,
    atMs: Number.isFinite(signal.atMs) ? signal.atMs : Date.now(),
  });
}

export function readEpicEntry(
  epic: string,
  nowMs: number = Date.now(),
): EpicEntrySignal | null {
  const key = String(epic ?? "").trim().toUpperCase();
  if (!key) return null;
  const sig = byEpic.get(key);
  if (!sig) return null;
  if (nowMs - sig.atMs > EPIC_ENTRY_TTL_MS) {
    byEpic.delete(key);
    return null;
  }
  return sig;
}

/** Test helper */
export function clearEpicEntrySync(): void {
  byEpic.clear();
}

export function latestEpicEntry(epic: string): EpicEntrySignal | null {
  const key = String(epic ?? "").trim().toUpperCase();
  return byEpic.get(key) ?? null;
}
