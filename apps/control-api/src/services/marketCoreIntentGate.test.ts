import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';

describe('Market Core EntryReady fail-closed while MASTER owns', () => {
  const prevOwns = process.env.MASTER_OWNS_PIPELINE;
  const prevAllow = process.env.MASTER_ALLOW_MARKET_CORE_INTENTS;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.MASTER_ALLOW_MARKET_CORE_INTENTS;
  });

  afterEach(() => {
    if (prevOwns == null) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prevOwns;
    if (prevAllow == null) delete process.env.MASTER_ALLOW_MARKET_CORE_INTENTS;
    else process.env.MASTER_ALLOW_MARKET_CORE_INTENTS = prevAllow;
    vi.restoreAllMocks();
  });

  it('blocks Market Core intents when owns_pipeline ON', async () => {
    process.env.MASTER_OWNS_PIPELINE = 'true';
    const { masterRuntime } = await import('../master/runtime.js');
    const prev = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    try {
      const {
        marketCoreEntryIntentsAllowed,
        marketCoreEntryIntentRefusal,
      } = await import('./marketCoreIntentGate.js');
      expect(marketCoreEntryIntentsAllowed()).toBe(false);
      const refusal = marketCoreEntryIntentRefusal();
      expect(refusal.refused).toBe(true);
      expect(refusal.error).toBe('MASTER_OWNS_PIPELINE');

      const { ingestAndExecuteIntent } = await import('./intentFanout.js');
      const r = await ingestAndExecuteIntent({
        epic: 'GOLD',
        direction: 'BUY',
        decision: 'ENTRY_READY',
      });
      expect(r.refused).toBe(true);
      expect(r.fanout.subscribers).toBe(0);
    } finally {
      masterRuntime.owns_pipeline_pref = prev;
    }
  });

  it('allows Market Core when owns OFF', async () => {
    process.env.MASTER_OWNS_PIPELINE = 'false';
    const { masterRuntime } = await import('../master/runtime.js');
    const prev = masterRuntime.owns_pipeline_pref;
    masterRuntime.setOwnsPipeline(false);
    try {
      const { marketCoreEntryIntentsAllowed } = await import(
        './marketCoreIntentGate.js'
      );
      expect(marketCoreEntryIntentsAllowed()).toBe(true);
    } finally {
      masterRuntime.owns_pipeline_pref = prev;
    }
  });

  it('MASTER_ALLOW_MARKET_CORE_INTENTS escape hatch while owns', async () => {
    process.env.MASTER_OWNS_PIPELINE = 'true';
    process.env.MASTER_ALLOW_MARKET_CORE_INTENTS = 'true';
    const { masterRuntime } = await import('../master/runtime.js');
    const prev = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    try {
      const { marketCoreEntryIntentsAllowed } = await import(
        './marketCoreIntentGate.js'
      );
      expect(marketCoreEntryIntentsAllowed()).toBe(true);
    } finally {
      masterRuntime.owns_pipeline_pref = prev;
    }
  });

  it('pipeline route source refuses intents while owns', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(
      join(process.cwd(), 'src/routes/pipeline.ts'),
      'utf8'
    );
    expect(src).toMatch(/marketCoreEntryIntentsAllowed/);
    expect(src).toMatch(/marketCoreEntryIntentRefusal/);
    expect(src).toMatch(/409/);
  });
});
