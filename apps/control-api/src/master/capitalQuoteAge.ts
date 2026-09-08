/**
 * Capital quote timestamp → quote ts_ms.
 * Fail-closed when missing/unparseable: stamp older than typical stale_quote_ms
 * so DATA_STALE gates fire (never forge Date.now() freshness).
 * Shared by REST markets, streaming WS, and desk bridge.
 */
export function capitalQuoteTsMs(
  updateTime: string | number | null | undefined,
  nowMs = Date.now()
): number {
  if (updateTime == null || updateTime === '') {
    return nowMs - 60_000;
  }
  if (typeof updateTime === 'number' && Number.isFinite(updateTime)) {
    const n = updateTime > 1e12 ? updateTime : updateTime * 1000;
    return n > 0 && n <= nowMs + 5_000 ? n : nowMs - 60_000;
  }
  const s = String(updateTime).trim();
  if (!s) return nowMs - 60_000;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      const ms = n > 1e12 ? n : n * 1000;
      return ms > 0 && ms <= nowMs + 5_000 ? ms : nowMs - 60_000;
    }
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= nowMs + 5_000) {
    return parsed;
  }
  return nowMs - 60_000;
}
