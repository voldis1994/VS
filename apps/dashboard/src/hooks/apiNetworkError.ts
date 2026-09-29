/**
 * Browser "Failed to fetch" usually means control-api is down / restarting.
 * Map it to an actionable message so the desk is not a dead end.
 */
export function humanizeApiNetworkError(err: unknown): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error('API timeout — dati neatjaunojas (API aizņemts vai karājas)');
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/failed to fetch|networkerror|load failed|econnrefused|network request failed/i.test(msg)) {
    return new Error(
      'API nereaģē (Failed to fetch) — skatīties MR-ControlAPI logu; live-loop restartē automātiski, vai palaid VS.bat'
    );
  }
  if (err instanceof Error) return err;
  return new Error(msg || 'API kļūda');
}
