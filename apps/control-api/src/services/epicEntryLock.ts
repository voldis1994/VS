/**
 * Serialize list→create across robot desk + pipeline fanout for one (account, epic).
 * Prevents TOCTOU double-entry when Admin entry brain and client subscription race.
 */
const chains = new Map<string, Promise<unknown>>();

function lockKey(accountId: number, epic: string): string {
  return `${accountId}::${String(epic || '').trim().toUpperCase()}`;
}

export async function withEpicEntryLock<T>(
  accountId: number,
  epic: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = lockKey(accountId, epic);
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  chains.set(key, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}
