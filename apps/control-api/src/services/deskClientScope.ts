/**
 * Desk client scope — AsyncLocalStorage so calibration / auto-cal / entry
 * filters resolve to the active client without threading ids through every call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type DeskClientStore = { clientId: number };

const als = new AsyncLocalStorage<DeskClientStore>();

/** Run fn with this client as the desk scope (robots / API handlers). */
export function runWithDeskClient<T>(clientId: number, fn: () => T): T {
  const id = Number(clientId);
  const safe = Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
  return als.run({ clientId: safe }, fn);
}

export async function runWithDeskClientAsync<T>(
  clientId: number,
  fn: () => Promise<T>
): Promise<T> {
  const id = Number(clientId);
  const safe = Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
  return als.run({ clientId: safe }, fn);
}

/** Active client from ALS, or null if outside a desk scope. */
export function getDeskClientId(): number | null {
  const id = als.getStore()?.clientId;
  if (id == null || !Number.isFinite(id) || id <= 0) return null;
  return Math.floor(id);
}

/**
 * Resolve client id: explicit > ALS > 0 (legacy/global bucket for tests).
 */
export function resolveDeskClientId(explicit?: number | null): number {
  if (explicit != null && Number.isFinite(Number(explicit)) && Number(explicit) > 0) {
    return Math.floor(Number(explicit));
  }
  return getDeskClientId() ?? 0;
}
