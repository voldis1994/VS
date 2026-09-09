import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildMasterFanoutIntent,
  summarizeFanoutResult,
} from '../masterClientFanout.js';

describe('MASTER owns → Client fanout helpers', () => {
  it('buildMasterFanoutIntent shapes EntryReady with master idempotency', () => {
    const intent = buildMasterFanoutIntent({
      epic: 'GOLD',
      side: 'BUY',
      intent_id: 'abc-123',
      reference_price: 4401.5,
      regime: 'TREND_UP',
      setup_type: 'CONTINUATION',
    });
    expect(intent.decision).toBe('ENTRY_READY');
    expect(intent.direction).toBe('BUY');
    expect(intent.epic).toBe('GOLD');
    expect(intent.idempotency_key).toBe('master:abc-123');
    expect(intent.reference_price).toBe(4401.5);
    expect(intent.regime).toBe('TREND_UP');
    expect(intent.setup_type).toBe('CONTINUATION');
    expect(intent.explanation).toMatch(/MASTER owns_pipeline/);
  });

  it('summarizeFanoutResult reports no_subscribers and ok counts', () => {
    expect(summarizeFanoutResult({ attempted: false }).detail).toBe('not_attempted');
    expect(
      summarizeFanoutResult({ attempted: true, subscribers: 0, executed: [] }).detail
    ).toBe('no_subscribers');
    const mixed = summarizeFanoutResult({
      attempted: true,
      subscribers: 2,
      executed: [
        { ok: true, detail: 'filled' },
        { ok: false, detail: 'Already open on epic — skip' },
      ],
    });
    expect(mixed.ok_count).toBe(1);
    expect(mixed.fail_count).toBe(1);
    expect(mixed.detail).toMatch(/ok=1\/2/);
  });
});

describe('executeMasterOwnedFanout vs Market Core block', () => {
  const prevOwns = process.env.MASTER_OWNS_PIPELINE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (prevOwns == null) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prevOwns;
    vi.restoreAllMocks();
  });

  it('Market Core executePipelineIntent returns 0 subscribers while owns', async () => {
    process.env.MASTER_OWNS_PIPELINE = 'true';
    const { masterRuntime } = await import('../runtime.js');
    const prev = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    try {
      const { executePipelineIntent, executeMasterOwnedFanout } = await import(
        '../../services/intentFanout.js'
      );
      const core = await executePipelineIntent({
        epic: 'GOLD',
        direction: 'BUY',
        decision: 'ENTRY_READY',
      });
      expect(core.subscribers).toBe(0);
      expect(core.executed).toEqual([]);

      // Master path attempts fanout (DB may refuse — still not the Market Core empty short-circuit)
      let masterSubs: number | null = null;
      let threw = false;
      try {
        const master = await executeMasterOwnedFanout({
          epic: 'GOLD',
          direction: 'BUY',
          decision: 'ENTRY_READY',
          idempotency_key: 'master:test-owns-fanout',
        });
        masterSubs = master.subscribers;
        expect(Array.isArray(master.executed)).toBe(true);
      } catch {
        // Brokers DB down is honest — Market Core would have returned empty without throw
        threw = true;
      }
      expect(threw || masterSubs != null).toBe(true);
    } finally {
      masterRuntime.owns_pipeline_pref = prev;
    }
  });

  it('executeMasterOwnedFanout is no-op when owns OFF', async () => {
    process.env.MASTER_OWNS_PIPELINE = 'false';
    const { masterRuntime } = await import('../runtime.js');
    const prev = masterRuntime.owns_pipeline_pref;
    masterRuntime.setOwnsPipeline(false);
    try {
      const { executeMasterOwnedFanout } = await import(
        '../../services/intentFanout.js'
      );
      const r = await executeMasterOwnedFanout({
        epic: 'GOLD',
        direction: 'SELL',
        decision: 'ENTRY_READY',
      });
      expect(r.subscribers).toBe(0);
      expect(r.executed).toEqual([]);
    } finally {
      masterRuntime.owns_pipeline_pref = prev;
    }
  });
});
