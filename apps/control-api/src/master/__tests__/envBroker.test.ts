import { afterEach, describe, expect, it } from 'vitest';
import { capitalEnvPresent, resolveBrokerFromEnv } from '../envBroker.js';

describe('VS MASTER env broker resolve', () => {
  const keys = [
    'CAPITAL_API_KEY',
    'CAPITAL_IDENTIFIER',
    'CAPITAL_API_PASSWORD',
    'MASTER_LIVE_ENABLED',
    'MASTER_MT4_BRIDGE',
  ];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
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
});
