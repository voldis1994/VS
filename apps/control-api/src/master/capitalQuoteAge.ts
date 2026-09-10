/**
 * Capital quote timestamp → quote ts_ms.
 *
 * When update_time is present, use it (never hide a truly aged venue mark).
 * When missing/unparseable:
 * - onMissing:'stale' (default) → age 60s so disk/cache / unknown sources fail DATA_STALE
 * - onMissing:'receive' → live wire tick just arrived (REST/WS/desk) — use receive time
 *   so Capital omitting update_time does not permanent-BLOCK ARMED setups
 */
export type CapitalQuoteTsOpts = {
  onMissing?: 'stale' | 'receive';
};

export function capitalQuoteTsMs(
  updateTime: string | number | null | undefined,
  nowMs = Date.now(),
  opts?: CapitalQuoteTsOpts
): number {
  const missingStamp =
    opts?.onMissing === 'receive' ? nowMs : nowMs - 60_000;

  if (updateTime == null || updateTime === '') {
    return missingStamp;
  }
  if (typeof updateTime === 'number' && Number.isFinite(updateTime)) {
    const n = updateTime > 1e12 ? updateTime : updateTime * 1000;
    return n > 0 && n <= nowMs + 5_000 ? n : missingStamp;
  }
  const s = String(updateTime).trim();
  if (!s) return missingStamp;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      const ms = n > 1e12 ? n : n * 1000;
      return ms > 0 && ms <= nowMs + 5_000 ? ms : missingStamp;
    }
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= nowMs + 5_000) {
    return parsed;
  }
  return missingStamp;
}
