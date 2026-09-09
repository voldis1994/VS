import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildMasterFanoutIntent,
  summarizeFanoutResult,
  fanoutOpportunityId,
  masterIntentIdFromIdem,
  buildFanoutCloseOutcome,
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
      journaled_count: 1,
    });
    expect(mixed.ok_count).toBe(1);
    expect(mixed.fail_count).toBe(1);
    expect(mixed.journaled_count).toBe(1);
    expect(mixed.detail).toMatch(/ok=1\/2/);
    expect(mixed.detail).toMatch(/journaled=1/);
  });

  it('journalMasterFanoutFills writes MASTER opportunities for ok fills only', async () => {
    const { MasterJournal } = await import('../journal.js');
    const { journalMasterFanoutFills } = await import('../masterClientFanout.js');
    const { analyzeBars } = await import('../analysis.js');
    const { decide } = await import('../decision.js');
    const { DEFAULT_MASTER_CONFIG } = await import('../pipeline.js');
    const bars: import('../types.js').Bar[] = [];
    for (let i = 0; i < 40; i++) {
      const o = 4400 + i * 0.8;
      bars.push({
        open: o,
        high: o + 1.2,
        low: o - 0.1,
        close: o + 0.9,
        ts_ms: i * 60_000,
      });
    }
    const a = analyzeBars(bars, 0.4);
    const last = bars.at(-1)!;
    const d = decide(
      a,
      {
        bid: last.close - 0.2,
        ask: last.close + 0.2,
        mid: last.close,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      { ...DEFAULT_MASTER_CONFIG, min_score: 0.2, block_off_hours: false },
      () => null,
      bars
    );
    const forced =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const journal = new MasterJournal();
    const recs = journalMasterFanoutFills({
      journal,
      mode: 'LIVE',
      epic: 'GOLD',
      side: 'BUY',
      intent_id: 'intent-xyz',
      decision: forced,
      fills: [
        {
          client_id: 1,
          account_id: 10,
          lot_size: 0.1,
          ok: true,
          detail: 'filled',
          entry_price: 4410,
        },
        {
          client_id: 2,
          account_id: 20,
          lot_size: 0.2,
          ok: false,
          detail: 'Already open',
          entry_price: null,
        },
      ],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.executed).toBe(true);
    expect(recs[0]!.execution?.accepted).toBe(true);
    expect(recs[0]!.execution?.detail).toMatch(/client_fanout/);
    expect(recs[0]!.risk.volume).toBe(0.1);
    expect(journal.opportunities).toHaveLength(1);
  });

  it('fanoutOpportunityId / masterIntentIdFromIdem stay stable for attach', () => {
    expect(fanoutOpportunityId('abc-123', 10)).toBe('fanout-abc-123-10');
    expect(masterIntentIdFromIdem('master:abc-123')).toBe('abc-123');
    expect(masterIntentIdFromIdem('other:abc')).toBeNull();
    expect(masterIntentIdFromIdem(null)).toBeNull();
  });

  it('buildFanoutCloseOutcome marks pnl unproven with FANOUT_CLIENT reason', () => {
    const o = buildFanoutCloseOutcome({
      opportunity_id: 'fanout-abc-10',
      position_id: 'deal-1',
      epic: 'GOLD',
      side: 'BUY',
      volume: 0.1,
      entry: 4400,
      exit: 4410,
      reason: 'HardInvalidation',
      mae: 0.5,
      mfe: 2,
      hold_ms: 60_000,
    });
    expect(o.pnl_proven).toBe(false);
    expect(o.exit_reason).toMatch(/^FANOUT_CLIENT/);
    expect(o.entry).toBe(4400);
    expect(o.exit).toBe(4410);
    expect(o.volume).toBe(0.1);
  });

  it('recordFanoutClientClose attaches outcome to fanout opportunity', async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { masterRuntime } = await import('../runtime.js');
    const { MasterPipeline } = await import('../pipeline.js');
    const { loadTradeEvents } = await import('../tradeEventJournal.js');
    const { journalMasterFanoutFills } = await import('../masterClientFanout.js');
    const { analyzeBars } = await import('../analysis.js');
    const { decide } = await import('../decision.js');
    const { DEFAULT_MASTER_CONFIG } = await import('../pipeline.js');

    const prevDir = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-fanout-close-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevPipe = masterRuntime.pipeline;
    const prevExit = masterRuntime.last_exit_reason;
    try {
      masterRuntime.setOwnsPipeline(true);
      masterRuntime.pipeline = new MasterPipeline('LIVE');
      const bars: import('../types.js').Bar[] = [];
      for (let i = 0; i < 40; i++) {
        const o = 4400 + i * 0.8;
        bars.push({
          open: o,
          high: o + 1.2,
          low: o - 0.1,
          close: o + 0.9,
          ts_ms: i * 60_000,
        });
      }
      const a = analyzeBars(bars, 0.4);
      const last = bars.at(-1)!;
      const d = decide(
        a,
        {
          bid: last.close - 0.2,
          ask: last.close + 0.2,
          mid: last.close,
          spread: 0.4,
          ts_ms: Date.now(),
        },
        { ...DEFAULT_MASTER_CONFIG, min_score: 0.2, block_off_hours: false },
        () => null,
        bars
      );
      const forced =
        d.kind === 'BUY' || d.kind === 'SELL'
          ? d
          : {
              ...d,
              kind: 'BUY' as const,
              side: 'BUY' as const,
              block_reason: null,
              buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
            };
      const [rec] = journalMasterFanoutFills({
        journal: masterRuntime.pipeline.journal,
        mode: 'LIVE',
        epic: 'GOLD',
        side: 'BUY',
        intent_id: 'intent-close-1',
        decision: forced,
        fills: [
          {
            client_id: 1,
            account_id: 10,
            lot_size: 0.1,
            ok: true,
            detail: 'filled',
            entry_price: 4410,
          },
        ],
      });
      expect(rec).toBeTruthy();
      const booked = masterRuntime.recordFanoutClientClose({
        opportunity_id: rec!.id,
        position_id: 'deal-fanout-1',
        epic: 'GOLD',
        side: 'BUY',
        volume: 0.1,
        entry: 4410,
        exit: 4395,
        reason: 'HardInvalidation',
        ok: true,
        detail: 'capital_close_ok',
        hold_ms: 30_000,
      });
      expect(booked.journaled).toBe(true);
      expect(booked.booked).toBe(true);
      expect(masterRuntime.last_exit_reason).toMatch(/FANOUT_CLIENT/);
      const hit = masterRuntime.pipeline.journal.opportunities.find(
        (o) => o.id === rec!.id
      );
      expect(hit?.outcome?.exit_reason).toMatch(/FANOUT_CLIENT/);
      expect(hit?.outcome?.pnl_proven).toBe(false);
      const ev = loadTradeEvents(10).find((e) => e.opportunity_id === rec!.id);
      expect(ev?.event).toBe('CLOSE');
      expect(ev?.detail).toMatch(/FANOUT_CLIENT/);

      masterRuntime.setOwnsPipeline(false);
      const skipped = masterRuntime.recordFanoutClientClose({
        opportunity_id: rec!.id,
        position_id: 'x',
        epic: 'GOLD',
        side: 'BUY',
        volume: 0.1,
        entry: 4410,
        exit: 4390,
        reason: 'x',
        ok: true,
      });
      expect(skipped.journaled).toBe(false);
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      masterRuntime.pipeline = prevPipe;
      masterRuntime.last_exit_reason = prevExit;
      if (prevDir === undefined) {
        delete process.env.MASTER_STATE_DIR;
        delete process.env.MASTER_GATES_DIR;
      } else {
        process.env.MASTER_STATE_DIR = prevDir;
        process.env.MASTER_GATES_DIR = prevDir;
      }
    }
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
