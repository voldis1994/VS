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
  ensureOperatorMetaFromStateDir,
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
    expect(loaded[0]!.playbook_at_entry).toBeTruthy();
    expect(loaded[0]!.entry_setup).toBeTruthy();
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

  it('recover keeps trailing consecutive_losses even when outcomes arrive newest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-fp-streak-'));
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);
    const now = Date.now();
    const mk = (id: string, pnl: number, minsAgo: number) => ({
      opportunity_id: id,
      setup_key: 'TREND:BUY',
      created_at: new Date(now - minsAgo * 60_000).toISOString(),
      outcome: {
        position_id: `p-${id}`,
        side: 'BUY' as const,
        entry: 100,
        exit: pnl < 0 ? 90 : 110,
        volume: 1,
        pnl,
        fees: 0,
        slippage: 0,
        mae: 1,
        mfe: 1,
        r_multiple: pnl < 0 ? -1 : 1,
        hold_ms: 1000,
        exit_reason: 'STOP_HIT',
      },
    });
    // Insert newest-first (file/memory reverse hazard) — streak must still be 2
    const { writeFileSync } = await import('fs');
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [],
        outcomes: [
          mk('00000000-0000-4000-8000-000000000003', -10, 1),
          mk('00000000-0000-4000-8000-000000000002', -20, 5),
          mk('00000000-0000-4000-8000-000000000001', 50, 10),
        ],
        positions: [],
        intents: [],
      })
    );
    installFilePersist(dir);
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.broker = null;
    masterRuntime.account.consecutive_losses = 0;
    await masterRuntime.recover();
    expect(masterRuntime.account.consecutive_losses).toBe(2);
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

  it('reads mirror when primary is up but empty (stale PG)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-dual-empty-'));
    const mirror = new FilePersist(dir);
    const emptyPrimary: PersistClientLike = {
      async query(sql: string) {
        if (/INSERT|UPDATE|DELETE/i.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [] };
      },
    };
    // Seed mirror via dual write (primary no-ops, mirror keeps rows)
    setPersistClient(new DualPersist(emptyPrimary as any, mirror));
    const pm = new PositionManager();
    pm.register({
      position_id: 'empty-pg-pos',
      opportunity_id: '00000000-0000-4000-8000-000000000099',
      intent_id: 'empty-pg-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'RANGE',
          market_state: 't',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0.2,
          structure_bias: 'NEUTRAL',
          swing_high: 4420,
          swing_low: 4400,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.001,
          atr: 1,
        },
        expectancy: null,
      },
    });
    expect(await saveOpenPositions(pm.list())).toBe(true);

    const mirror2 = new FilePersist(dir);
    setPersistClient(new DualPersist(emptyPrimary as any, mirror2));
    const loaded = await loadOpenPositions();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.position_id).toBe('empty-pg-pos');
  });

  it('prefers newer mirror open book when non-empty primary is stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-dual-stale-opens-'));
    const primary = new MemoryPersist();
    const mirror = new FilePersist(dir);
    const dual = new DualPersist(primary, mirror);
    setPersistClient(dual);
    const decision = {
      decision_id: 'd',
      kind: 'BUY' as const,
      side: 'BUY' as const,
      score: 0.7,
      block_reason: null,
      buy: null as never,
      sell: null as never,
      analysis: {
        regime: 'RANGE' as const,
        market_state: 't',
        momentum_score: 0,
        momentum_dir: 'NEUTRAL' as const,
        trend_dir: 'SIDEWAYS' as const,
        trend_strength: 0.2,
        structure_bias: 'NEUTRAL' as const,
        swing_high: 4420,
        swing_low: 4400,
        buy_pressure: 0.5,
        sell_pressure: 0.5,
        behavior_bull: 0.5,
        behavior_bear: 0.5,
        impact_score: 0.5,
        context_quality: 0.5,
        volatility: 0.001,
        atr: 1,
      },
      expectancy: null,
    };
    const pm = new PositionManager();
    pm.register({
      position_id: 'stale-open-1',
      opportunity_id: '00000000-0000-4000-8000-0000000000a1',
      intent_id: 'stale-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      decision,
    });
    expect(await saveOpenPositions(pm.list())).toBe(true);
    // Advance only the mirror (simulate primary write failure mid-manage)
    const advanced = pm.list().map((p) => ({
      ...p,
      stop_loss: 4405,
      size: 0.05,
    }));
    setPersistClient(mirror);
    expect(await saveOpenPositions(advanced)).toBe(true);
    // Primary still has old SL/size; DualPersist read must prefer mirror
    setPersistClient(new DualPersist(primary, new FilePersist(dir)));
    const loaded = await loadOpenPositions();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.position_id).toBe('stale-open-1');
    expect(loaded[0]!.stop_loss).toBe(4405);
    expect(loaded[0]!.size).toBe(0.05);
  });

  it('prefers newer mirror singleton when primary saved_at_ms is older', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-dual-stale-single-'));
    const primary = new MemoryPersist();
    const mirror = new FilePersist(dir);
    setPersistClient(new DualPersist(primary, mirror));
    const { persistRuntimeGatesState, loadRuntimeGatesFromPersist } =
      await import('../persist.js');
    await persistRuntimeGatesState({
      peak_equity: 10_000,
      consecutive_losses: 1,
      saved_at_ms: 1_000,
    });
    // Stale primary, newer mirror only
    primary.runtimeGatesPayload = {
      peak_equity: 10_000,
      consecutive_losses: 1,
      saved_at_ms: 1_000,
    };
    await mirror.query(
      `INSERT INTO master_runtime_gates (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({
          peak_equity: 12_500,
          consecutive_losses: 0,
          saved_at_ms: 9_000,
        }),
        9_000,
      ]
    );
    setPersistClient(new DualPersist(primary, mirror));
    const loaded = await loadRuntimeGatesFromPersist();
    expect(Number(loaded?.peak_equity)).toBe(12_500);
    expect(Number(loaded?.consecutive_losses)).toBe(0);
    expect(Number(loaded?.saved_at_ms)).toBe(9_000);
  });

  it('merges pnl_proven:false from file mirror onto PG null rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-dual-pnl-'));
    const mirror = new FilePersist(dir);
    const oppId = '00000000-0000-4000-8000-00000000d001';
    // Seed mirror with unproven flag
    await mirror.query(
      `INSERT INTO master_trade_outcomes (
         id, opportunity_id, side, entry_price, exit_price, volume, pnl,
         fees, slippage, mae, mfe, r_multiple, hold_ms, exit_reason, setup_key,
         position_id, pnl_proven
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        'id1',
        oppId,
        'BUY',
        4410,
        4410,
        0.1,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        'capital_close_pnl_unproven',
        'TREND:BUY',
        'deal-1',
        false,
      ]
    );
    // Primary returns same row shape without pnl_proven (legacy PG)
    const primary: PersistClientLike = {
      async query(sql: string) {
        if (/SELECT/i.test(sql) && /master_trade_outcomes/i.test(sql)) {
          return {
            rows: [
              {
                opportunity_id: oppId,
                position_id: 'deal-1',
                side: 'BUY',
                entry_price: 4410,
                exit_price: 4410,
                volume: 0.1,
                pnl: 0,
                fees: 0,
                slippage: 0,
                mae: 0,
                mfe: 0,
                r_multiple: 0,
                hold_ms: 1,
                exit_reason: 'capital_close_pnl_unproven',
                setup_key: 'TREND:BUY',
                created_at: new Date().toISOString(),
                pnl_proven: null,
              },
            ],
          };
        }
        if (/SELECT/i.test(sql) && /master_opportunities/i.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    setPersistClient(new DualPersist(primary as any, mirror));
    const hist = await loadJournalHistory();
    expect(hist.outcomes.length).toBe(1);
    expect(hist.outcomes[0]!.outcome.pnl_proven).toBe(false);
  });
});

describe('VS MASTER stop() empty-wipe guard', () => {
  afterEach(() => {
    setPersistClient(null);
    masterRuntime.stop();
  });

  it('does not wipe durable opens when stop() runs before recover', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-stop-guard-'));
    installFilePersist(dir);
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
      position_id: 'guard-pos-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'guard-intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      decision: cycle.decision,
    });
    expect(await saveOpenPositions(pm.list())).toBe(true);

    // Fresh runtime — unrecovered, empty in-memory book
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.broker = null;
    masterRuntime.recovered = false;
    masterRuntime.running = false;
    masterRuntime.stop();

    const still = await loadOpenPositions();
    expect(still.length).toBe(1);
    expect(still[0]!.position_id).toBe('guard-pos-1');
  });

  it('operator_meta in master_state restores manage/owns when sidecars missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-opmeta-'));
    const fp = new FilePersist(dir);
    // Seed sidecars then flush into master_state.json
    const { writeFileSync, unlinkSync } = require('fs') as typeof import('fs');
    writeFileSync(
      join(dir, 'master_manage_config.json'),
      JSON.stringify({ soft_trail_money_arm: 0.05, multi_tp_count: 3 })
    );
    writeFileSync(join(dir, 'owns_pipeline.json'), JSON.stringify({ owns_pipeline: true }));
    writeFileSync(
      join(dir, 'runtime_gates.json'),
      JSON.stringify({ last_loss_ms: 42, reject_until_ms: 0 })
    );
    fp.flush();
    const state = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
    expect(state.operator_meta?.manage?.soft_trail_money_arm).toBe(0.05);
    expect(state.operator_meta?.owns_pipeline).toBe(true);
    // Wipe sidecars — reload must restore
    unlinkSync(join(dir, 'master_manage_config.json'));
    unlinkSync(join(dir, 'owns_pipeline.json'));
    unlinkSync(join(dir, 'runtime_gates.json'));
    const fp2 = new FilePersist(dir);
    void fp2;
    expect(existsSync(join(dir, 'master_manage_config.json'))).toBe(true);
    const manage = JSON.parse(
      readFileSync(join(dir, 'master_manage_config.json'), 'utf8')
    );
    expect(manage.multi_tp_count).toBe(3);
    const owns = JSON.parse(readFileSync(join(dir, 'owns_pipeline.json'), 'utf8'));
    expect(owns.owns_pipeline).toBe(true);
  });

  it('ensureOperatorMetaFromStateDir restores wiped sidecars mid-process', () => {
    const { writeFileSync, unlinkSync } = require('fs') as typeof import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'master-opmeta-mid-'));
    const fp = new FilePersist(dir);
    writeFileSync(
      join(dir, 'master_manage_config.json'),
      JSON.stringify({ trail_start: 1.5, trail_lock: 0.8 })
    );
    writeFileSync(
      join(dir, 'owns_pipeline.json'),
      JSON.stringify({ owns_pipeline: false })
    );
    fp.flush();
    unlinkSync(join(dir, 'master_manage_config.json'));
    unlinkSync(join(dir, 'owns_pipeline.json'));
    expect(existsSync(join(dir, 'master_manage_config.json'))).toBe(false);
    const ok = ensureOperatorMetaFromStateDir(dir);
    expect(ok).toBe(true);
    expect(existsSync(join(dir, 'master_manage_config.json'))).toBe(true);
    const manage = JSON.parse(
      readFileSync(join(dir, 'master_manage_config.json'), 'utf8')
    );
    expect(manage.trail_start).toBe(1.5);
    const owns = JSON.parse(readFileSync(join(dir, 'owns_pipeline.json'), 'utf8'));
    expect(owns.owns_pipeline).toBe(false);
    // Instance cache also restores after wipe without re-reading disk meta
    unlinkSync(join(dir, 'master_manage_config.json'));
    expect(fp.ensureOperatorMetaFromState()).toBe(true);
    expect(existsSync(join(dir, 'master_manage_config.json'))).toBe(true);
  });

  it('operator_meta restores market_cache sidecar when wiped', () => {
    const { writeFileSync, unlinkSync } = require('fs') as typeof import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'master-opmeta-mkt-'));
    const fp = new FilePersist(dir);
    writeFileSync(
      join(dir, 'market_cache.json'),
      JSON.stringify({
        epic: 'GOLD',
        bars: [
          { open: 4400, high: 4401, low: 4399, close: 4400.5, ts_ms: 1 },
          { open: 4401, high: 4402, low: 4400, close: 4401.5, ts_ms: 2 },
          { open: 4402, high: 4403, low: 4401, close: 4402.5, ts_ms: 3 },
          { open: 4403, high: 4404, low: 4402, close: 4403.5, ts_ms: 4 },
          { open: 4404, high: 4405, low: 4403, close: 4404.5, ts_ms: 5 },
        ],
        hour_bars: Array.from({ length: 6 }, (_, i) => ({
          open: 4300 + i,
          high: 4302 + i,
          low: 4298 + i,
          close: 4301 + i,
          ts_ms: i + 1,
        })),
        closed_10s: {
          open_time_ms: 1_000,
          open: 4404,
          high: 4405,
          low: 4403,
          close: 4404.5,
          ticks: 2,
        },
        quote: null,
        structure_seed_source: 'capital_ohlc',
        saved_at_ms: Date.now(),
      })
    );
    fp.flush();
    const state = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
    expect(state.operator_meta?.market_cache?.bars?.length).toBe(5);
    expect(state.operator_meta?.market_cache?.hour_bars?.length).toBe(6);
    expect(state.operator_meta?.market_cache?.closed_10s?.close).toBe(4404.5);
    expect(state.operator_meta?.market_cache?.epic).toBe('GOLD');
    unlinkSync(join(dir, 'market_cache.json'));
    expect(existsSync(join(dir, 'market_cache.json'))).toBe(false);
    expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
    expect(existsSync(join(dir, 'market_cache.json'))).toBe(true);
    const cache = JSON.parse(readFileSync(join(dir, 'market_cache.json'), 'utf8'));
    expect(cache.bars.length).toBe(5);
    expect(cache.hour_bars.length).toBe(6);
    expect(cache.closed_10s.close).toBe(4404.5);
    expect(cache.structure_seed_source).toBe('capital_ohlc');
  });

  it('heals corrupt owns_pipeline.json from operator_meta', () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'master-owns-corrupt-'));
    const fp = new FilePersist(dir);
    writeFileSync(join(dir, 'owns_pipeline.json'), JSON.stringify({ owns_pipeline: true }));
    fp.flush();
    writeFileSync(join(dir, 'owns_pipeline.json'), '{not-json');
    expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
    const owns = JSON.parse(readFileSync(join(dir, 'owns_pipeline.json'), 'utf8'));
    expect(owns.owns_pipeline).toBe(true);
  });

  it('saveRuntimeGates embeds desired_running; survives sidecar wipe', async () => {
    const { writeFileSync, unlinkSync } = require('fs') as typeof import('fs');
    const prev = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'master-gates-embed-'));
    process.env.MASTER_STATE_DIR = dir;
    try {
      writeFileSync(
        join(dir, 'master_state.json'),
        JSON.stringify({
          opportunities: [],
          outcomes: [],
          positions: [],
          intents: [],
          operator_meta: { owns_pipeline: true },
        })
      );
      const { saveRuntimeGates, loadRuntimeGates } = await import('../runtimeGates.js');
      expect(
        saveRuntimeGates({
          last_loss_ms: 0,
          reject_until_ms: 0,
          desired_running: true,
          kill_switch: true,
          mode: 'PAPER',
          epic: 'GOLD',
        })
      ).toBe(true);
      const state = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
      expect(state.operator_meta?.owns_pipeline).toBe(true);
      expect(state.operator_meta?.gates?.desired_running).toBe(true);
      expect(state.operator_meta?.gates?.kill_switch).toBe(true);
      expect(state.operator_meta?.gates?.mode).toBe('PAPER');
      unlinkSync(join(dir, 'runtime_gates.json'));
      expect(existsSync(join(dir, 'runtime_gates.json'))).toBe(false);
      expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
      expect(loadRuntimeGates()?.desired_running).toBe(true);
      expect(loadRuntimeGates()?.kill_switch).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('saveManageConfig/saveOwnsPipelinePref embed; partial wipe keeps other fields', async () => {
    const { writeFileSync, unlinkSync } = require('fs') as typeof import('fs');
    const prev = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'master-manage-owns-embed-'));
    process.env.MASTER_STATE_DIR = dir;
    try {
      writeFileSync(
        join(dir, 'master_state.json'),
        JSON.stringify({
          opportunities: [],
          outcomes: [],
          positions: [],
          intents: [],
          operator_meta: {},
        })
      );
      const { saveManageConfig, loadManageConfig } = await import('../manageConfig.js');
      const { saveOwnsPipelinePref, loadOwnsPipelinePref } = await import(
        '../ownsPipelinePref.js'
      );
      const { saveRuntimeGates } = await import('../runtimeGates.js');
      expect(saveOwnsPipelinePref(true)).toBe(true);
      expect(saveManageConfig({ soft_trail_money_arm: 0.07, multi_tp_count: 2 })).toBe(
        true
      );
      expect(
        saveRuntimeGates({
          last_loss_ms: 1,
          reject_until_ms: 2,
          desired_running: true,
        })
      ).toBe(true);
      let state = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
      expect(state.operator_meta?.owns_pipeline).toBe(true);
      expect(state.operator_meta?.manage?.soft_trail_money_arm).toBe(0.07);
      expect(state.operator_meta?.gates?.desired_running).toBe(true);

      // Wipe only gates — flush must not null manage/owns in operator_meta
      unlinkSync(join(dir, 'runtime_gates.json'));
      const fp = new FilePersist(dir);
      fp.flush();
      state = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
      expect(state.operator_meta?.gates?.desired_running).toBe(true);
      expect(state.operator_meta?.manage?.multi_tp_count).toBe(2);
      expect(state.operator_meta?.owns_pipeline).toBe(true);

      unlinkSync(join(dir, 'master_manage_config.json'));
      unlinkSync(join(dir, 'owns_pipeline.json'));
      expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
      expect(loadManageConfig()?.soft_trail_money_arm).toBe(0.07);
      expect(loadOwnsPipelinePref()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});

type PersistClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};
