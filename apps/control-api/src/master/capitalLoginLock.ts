/**
 * VS-System Capital login lock — serialize REST ops for one login.
 * Reentrancy only via AsyncLocalStorage (nested place→list→modify OK).
 * Sibling callers (manageTick vs sync vs live-feed quote) must queue.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const owner = new AsyncLocalStorage<true>();

export type LoginLockState = {
  tail: Promise<unknown>;
};

export function createLoginLockState(): LoginLockState {
  return { tail: Promise.resolve() };
}

export async function withLoginLock<T>(
  state: LoginLockState,
  fn: () => Promise<T>
): Promise<T> {
  if (owner.getStore()) {
    return fn();
  }
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const prev = state.tail;
  state.tail = prev.then(
    () => gate,
    () => gate
  );
  await prev.catch(() => undefined);
  try {
    return await owner.run(true, fn);
  } finally {
    release();
  }
}

/** Test helper — true when current async context holds the lock. */
export function loginLockHeld(): boolean {
  return owner.getStore() === true;
}
