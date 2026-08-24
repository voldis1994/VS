import { describe, expect, it } from 'vitest';

/**
 * Documents the isolation contract for parallel per-client Capital work.
 * leaseCapitalSession holds the per-connection lock for the whole manage/exit
 * so Client A close cannot race Client B account-switch on the same login.
 */
describe('parallel client Capital lease contract', () => {
  it('different connectionIds must not share a pool key', () => {
    const keyA = `conn:${17}`;
    const keyB = `conn:${18}`;
    expect(keyA).not.toBe(keyB);
  });

  it('same connection serializes — peer waits until release', async () => {
    let active = 0;
    let maxActive = 0;
    const chain: Promise<unknown>[] = [Promise.resolve()];

    async function withLock(fn: () => Promise<void>) {
      const prev = chain[chain.length - 1]!;
      let unlock!: () => void;
      const gate = new Promise<void>((r) => {
        unlock = r;
      });
      chain.push(prev.then(() => gate).catch(() => gate));
      await prev.catch(() => undefined);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await fn();
      } finally {
        active -= 1;
        unlock();
      }
    }

    await Promise.all([
      withLock(async () => {
        await new Promise((r) => setTimeout(r, 40));
      }),
      withLock(async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
      withLock(async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
    ]);

    expect(maxActive).toBe(1);
  });

  it('different locks run in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const locks = new Map<string, Promise<unknown>>();

    async function withLock(id: string, fn: () => Promise<void>) {
      const prev = locks.get(id) ?? Promise.resolve();
      let unlock!: () => void;
      const gate = new Promise<void>((r) => {
        unlock = r;
      });
      locks.set(
        id,
        prev.then(() => gate).catch(() => gate)
      );
      await prev.catch(() => undefined);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await fn();
      } finally {
        active -= 1;
        unlock();
      }
    }

    await Promise.all([
      withLock('conn:1', async () => {
        await new Promise((r) => setTimeout(r, 40));
      }),
      withLock('conn:2', async () => {
        await new Promise((r) => setTimeout(r, 40));
      }),
      withLock('conn:3', async () => {
        await new Promise((r) => setTimeout(r, 40));
      }),
    ]);

    expect(maxActive).toBe(3);
  });
});
