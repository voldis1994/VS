import { afterEach, describe, expect, it } from 'vitest';
import { createCapitalBroker, masterCapitalConnectionId } from '../capitalFactory.js';
import { sharedLoginLockForConnection } from '../capitalLoginLock.js';
import { deskCapitalPoolConnectionId } from '../deskBridge.js';
import { capitalEnvPresent, mt4LegacyAllowed, resolveBrokerFromEnv } from '../envBroker.js';
import { masterRuntime } from '../runtime.js';

describe('VS MASTER env broker resolve', () => {
  const keys = [
    'CAPITAL_API_KEY',
    'CAPITAL_IDENTIFIER',
    'CAPITAL_API_PASSWORD',
    'MASTER_LIVE_ENABLED',
    'MASTER_MT4_BRIDGE',
    'MASTER_ALLOW_MT4_LEGACY',
    'MASTER_CAPITAL_CONNECTION_ID',
    'MASTER_OWNS_PIPELINE',
  ];
  const saved: Record<string, string | undefined> = {};
  const prevOwnsPref = masterRuntime.owns_pipeline_pref;

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    masterRuntime.owns_pipeline_pref = prevOwnsPref;
  });

  function snap() {
    for (const k of keys) saved[k] = process.env[k];
  }

  it('defaults to paper when no Capital env', async () => {
    snap();
    for (const k of keys) delete process.env[k];
    expect(capitalEnvPresent()).toBe(false);
    const r = await resolveBrokerFromEnv();
    expect(r.broker.name).toBe('PAPER');
    expect(r.mode).toBe('PAPER');
  });

  it('falls back to paper when LIVE requested without credentials', async () => {
    snap();
    for (const k of keys) delete process.env[k];
    process.env.MASTER_LIVE_ENABLED = 'true';
    const r = await resolveBrokerFromEnv();
    expect(r.ok).toBe(false);
    expect(r.broker.paper).toBe(true);
    expect(r.mode).toBe('PAPER');
    expect(r.detail).toMatch(/CAPITAL_/);
  });

  it('prefers Capital over MT4 bridge when LIVE + CAPITAL_* set', async () => {
    snap();
    for (const k of keys) delete process.env[k];
    process.env.MASTER_LIVE_ENABLED = 'true';
    process.env.MASTER_MT4_BRIDGE = '/tmp/vs-mt4-should-not-win';
    process.env.MASTER_ALLOW_MT4_LEGACY = 'true';
    process.env.CAPITAL_API_KEY = 'k';
    process.env.CAPITAL_IDENTIFIER = 'i';
    process.env.CAPITAL_API_PASSWORD = 'p';
    const r = await resolveBrokerFromEnv();
    expect(r.broker.name).toBe('CAPITAL');
    expect(r.mode).toBe('LIVE');
    expect(r.broker.name).not.toBe('MT4_FILE');
  });

  it('refuses MT4 bridge without MASTER_ALLOW_MT4_LEGACY', async () => {
    snap();
    for (const k of keys) delete process.env[k];
    process.env.MASTER_MT4_BRIDGE = '/tmp/vs-mt4-legacy-test';
    expect(mt4LegacyAllowed()).toBe(false);
    const r = await resolveBrokerFromEnv();
    expect(r.ok).toBe(false);
    expect(r.broker.name).toBe('PAPER');
    expect(r.detail).toMatch(/MASTER_ALLOW_MT4_LEGACY/);
  });

  it('allows MT4 only as legacy when Capital missing + ALLOW flag', async () => {
    snap();
    for (const k of keys) delete process.env[k];
    process.env.MASTER_MT4_BRIDGE = '/tmp/vs-mt4-legacy-ok';
    process.env.MASTER_ALLOW_MT4_LEGACY = 'true';
    const r = await resolveBrokerFromEnv();
    expect(r.broker.name).toBe('MT4_FILE');
    expect(r.detail).toMatch(/mt4_legacy/);
  });

  it('desk MASTER pool ignores DB connectionId (shares env 900001 CST lock)', () => {
    snap();
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
    // envBroker + deskBridge both call masterCapitalConnectionId() with no desk DB id
    const envPool = masterCapitalConnectionId();
    const deskPool = masterCapitalConnectionId();
    const dbFork = masterCapitalConnectionId(777001);
    expect(envPool).toBe(900001);
    expect(deskPool).toBe(envPool);
    expect(dbFork).not.toBe(envPool);
    expect(sharedLoginLockForConnection(deskPool)).toBe(
      sharedLoginLockForConnection(envPool)
    );
    expect(sharedLoginLockForConnection(dbFork)).not.toBe(
      sharedLoginLockForConnection(envPool)
    );
    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
      connectionId: deskPool,
    });
    expect(
      sharedLoginLockForConnection(
        Number(
          (broker as unknown as { deps: { credentials: { connectionId: number } } }).deps
            .credentials.connectionId
        )
      )
    ).toBe(sharedLoginLockForConnection(envPool));
  });

  it('createCapitalBroker ignores desk DB connectionId (always MASTER pool)', () => {
    snap();
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
      connectionId: 424242,
    });
    expect(
      Number(
        (broker as unknown as { deps: { credentials: { connectionId: number } } }).deps
          .credentials.connectionId
      )
    ).toBe(900001);
  });

  it('deskCapitalPoolConnectionId shares MASTER pool when owns-pipeline', () => {
    snap();
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
    masterRuntime.owns_pipeline_pref = null;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    expect(deskCapitalPoolConnectionId(55)).toBe(900001);
    process.env.MASTER_OWNS_PIPELINE = 'false';
    expect(deskCapitalPoolConnectionId(55)).toBe(55);
  });

  it('owns-pipeline pool remap keeps DB id distinct from pool id (creds vs CST)', () => {
    snap();
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
    masterRuntime.owns_pipeline_pref = null;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    const dbId = 42;
    const poolId = deskCapitalPoolConnectionId(dbId);
    expect(poolId).toBe(900001);
    expect(poolId).not.toBe(dbId);
    // Same login lock as createCapitalBroker / env MASTER
    expect(sharedLoginLockForConnection(poolId)).toBe(
      sharedLoginLockForConnection(masterCapitalConnectionId())
    );
  });

  it('bindCapitalAccount mutates credentials so ensureAccount pins new CFD', async () => {
    snap();
    process.env.MASTER_LIVE_ENABLED = 'true';
    let pinned: string | null = null;
    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
      capitalAccountId: 'cfd-A',
    });
    // Replace ensure path by binding then reading credentials
    broker.bindCapitalAccount('cfd-B');
    expect(
      (broker as unknown as { deps: { credentials: { capitalAccountId: string } } }).deps
        .credentials.capitalAccountId
    ).toBe('cfd-B');
    // Mock session pin via rebind with stubbed acquire/ensure
    (broker as unknown as { deps: { acquire: Function; ensureAccount: Function } }).deps.acquire =
      async () => ({
        ok: true,
        session: { id: 's', preferredAccountId: null },
        detail: 'ok',
      });
    (broker as unknown as { deps: { ensureAccount: Function } }).deps.ensureAccount = async (
      session: { preferredAccountId: string | null }
    ) => {
      const id = String(
        (broker as unknown as { deps: { credentials: { capitalAccountId: string } } }).deps
          .credentials.capitalAccountId || ''
      ).trim();
      pinned = id;
      session.preferredAccountId = id;
      return { ok: true, detail: `switched:${id}` };
    };
    const r = await broker.rebindCapitalAccount('cfd-C');
    expect(r.ok).toBe(true);
    expect(pinned).toBe('cfd-C');
  });
});
