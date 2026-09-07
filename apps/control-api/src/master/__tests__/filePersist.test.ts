import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DualPersist,
  resetMasterPersistInstallFlag,
} from '../dualPersist.js';
import {
  FilePersist,
  installFilePersist,
} from '../filePersist.js';
import {
  loadJournalHistory,
  loadOpenPositions,
  loadSeenIntents,
  MemoryPersist,
  persistOpportunity,
  persistOutcome,
  saveOpenPositions,
  saveSeenIntents,
  setPersistClient,
} from '../persist.js';
import { PositionManager } from '../positionManager.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { masterRuntime } from '../runtime.js';
import type { Bar, Quote } from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({ open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: i * 60_000 });
  }
  return out;
}

function quoteFrom(bar: Bar): Quote {
  return {
    bid: bar.close - 0.2,
    ask: bar.close + 0.2,
    mid: bar.close,
    spread: 0.4,
    ts_ms: Date.now(),
  };
}

describe('VS MASTER file persist restart', () => {
  afterEach(() => setPersistClient(null));

  it('survives process-style restart via state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-fp-'));
    installFilePersist(dir);

    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const cycle = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });

    const pm = new PositionManager();
    pm.register({
      position_id: 'file-pos-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'file-intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      decision: cycle.decision,
    });
    await saveOpenPositions(pm.list());
    await saveSeenIntents(['file-intent-1']);
    await persistOpportunity(cycle.opportunity);
    await persistOutcome(
      cycle.opportunity.id,
      {
        position_id: 'file-pos-1',
        side: 'BUY',
        entry: 4410,
        exit: 4415,
        volume: 0.1,
        pnl: 5,
        fees: 0.1,
        slippage: 0,
        mae: 1,
        mfe: 6,
        r_multiple: 1,
        hold_ms: 60_000,
        exit_reason: 'TakeProfit',
      },
      'TREND:BUY'
    );

    expect(existsSync(join(dir, 'master_state.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
    expect(raw.positions.length).toBe(1);
    expect(raw.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(raw.outcomes.length).toBeGreaterThanOrEqual(1);

    // Simulate restart — new FilePersist loads disk
    setPersistClient(null);
    installFilePersist(dir);
    const loaded = await loadOpenPositions();
    const intents = await loadSeenIntents();
    const hist = await loadJournalHistory();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.position_id).toBe('file-pos-1');
    expect(loaded[0]!.decision).toBeTruthy();
    expect(intents).toContain('file-intent-1');
    expect(hist.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(hist.outcomes.length).toBeGreaterThanOrEqual(1);
    expect(hist.outcomes[0]!.outcome.pnl).toBe(5);
    expect(hist.outcomes[0]!.created_at).toBeTruthy();
    // created_at must not be rewritten to "now" on every load
    const createdBefore = hist.outcomes[0]!.created_at;
    installFilePersist(dir);
    const hist2 = await loadJournalHistory();
    expect(hist2.outcomes[0]!.created_at).toBe(createdBefore);

    // Do not call stop() before recover — stop() persists current (empty) opens and would wipe disk.
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.broker = null;
    masterRuntime.broker_detail = null;
    masterRuntime.running = false;
    masterRuntime.account.daily_pnl = 0;
    const recovered = await masterRuntime.recover();
    expect(recovered.positions).toBe(1);
    expect(recovered.opportunities).toBeGreaterThanOrEqual(1);
    expect(recovered.outcomes).toBeGreaterThanOrEqual(1);
    expect(masterRuntime.pipeline.journal.opportunities.length).toBeGreaterThanOrEqual(1);
    expect(masterRuntime.pipeline.expectancy.lookup('TREND:BUY')?.samples).toBeGreaterThanOrEqual(1);
    // Outcome stamped in this test run → counts as today
    expect(masterRuntime.account.daily_pnl).toBe(5);
  });

  it('recover ignores outcomes with missing/epoch created_at for daily_pnl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-fp-old-'));
    installFilePersist(dir);
    const { writeFileSync } = await import('fs');
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-000000000001',
            setup_key: 'TREND:BUY',
            // legacy row without created_at — load maps to epoch
            outcome: {
              position_id: 'p1',
              side: 'BUY',
              entry: 100,
              exit: 90,
              volume: 1,
              pnl: -500,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [],
        intents: [],
      })
    );
    installFilePersist(dir);
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.broker = null;
    masterRuntime.account.daily_pnl = 99;
    await masterRuntime.recover();
    // −500 must NOT inflate today's daily loss
    expect(masterRuntime.account.daily_pnl).toBe(0);
  });
});

describe('VS MASTER dual persist (DB fail → file mirror)', () => {
  afterEach(() => {
    setPersistClient(null);
    resetMasterPersistInstallFlag();
  });

  it('recovers opens from file mirror when primary throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-dual-'));
    const mirror = new FilePersist(dir);
    const failingPrimary: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
    } = {
      query: async () => {
        throw new Error('db_down');
      },
    };
    const dual = new DualPersist(failingPrimary as any, mirror);
    setPersistClient(dual);

    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const cycle = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    pm.register({
      position_id: 'dual-pos-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'dual-intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      decision: cycle.decision,
    });
    expect(await saveOpenPositions(pm.list())).toBe(true);
    expect(await saveSeenIntents(['dual-intent-1'])).toBe(true);
    expect(await persistOpportunity(cycle.opportunity)).toBe(true);

    // New dual with still-failing primary reads from mirror
    const mirror2 = new FilePersist(dir);
    setPersistClient(new DualPersist(failingPrimary as any, mirror2));
    const loaded = await loadOpenPositions();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.position_id).toBe('dual-pos-1');
    expect(await loadSeenIntents()).toContain('dual-intent-1');
  });

  it('writes succeed via mirror even when primary fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-dual-w-'));
    const mem = new MemoryPersist();
    const mirror = new FilePersist(dir);
    // Primary that fails only on write
    const flaky: PersistClientLike = {
      async query(sql: string, params: unknown[] = []) {
        if (/INSERT|UPDATE|DELETE/i.test(sql)) throw new Error('db_write_fail');
        return mem.query(sql, params);
      },
    };
    setPersistClient(new DualPersist(flaky as any, mirror));
    const ok = await saveSeenIntents(['flaky-intent']);
    expect(ok).toBe(true);
    setPersistClient(null);
    installFilePersist(dir);
    expect(await loadSeenIntents()).toContain('flaky-intent');
  });
});

type PersistClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};
