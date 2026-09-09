import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { masterRuntime } from '../master/runtime.js';
import { PositionManager } from '../master/positionManager.js';
import { MasterPipeline } from '../master/pipeline.js';
import { loadTradeEvents } from '../master/tradeEventJournal.js';

function analysis() {
  return {
    regime: 'RANGE' as const,
    market_state: 'test',
    momentum_score: 0,
    momentum_dir: 'NEUTRAL' as const,
    trend_dir: 'SIDEWAYS' as const,
    trend_strength: 0.2,
    structure_bias: 'NEUTRAL' as const,
    swing_high: 4405,
    swing_low: 4395,
    buy_pressure: 0.55,
    sell_pressure: 0.45,
    behavior_bull: 0.5,
    behavior_bear: 0.5,
    impact_score: 0.5,
    context_quality: 0.6,
    volatility: 0.001,
    atr: 1.5,
    data_quality: 0.8,
    session: 'LONDON' as const,
  };
}

describe('desk hard exit → MASTER journal', () => {
  it('recordDeskOwnedClose journals trade event and books local when owns ON', () => {
    const prevDir = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-desk-hard-j-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;

    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevPositions = masterRuntime.positions;
    const prevPipe = masterRuntime.pipeline;
    const prevExit = masterRuntime.last_exit_reason;

    try {
      masterRuntime.setOwnsPipeline(false);
      const skipped = masterRuntime.recordDeskOwnedClose({
        position_id: 'd1',
        epic: 'GOLD',
        side: 'BUY',
        volume: 0.1,
        exit: 4410,
        reason: 'HardInvalidation',
        ok: true,
      });
      expect(skipped.journaled).toBe(false);
      expect(loadTradeEvents(5).length).toBe(0);

      masterRuntime.setOwnsPipeline(true);
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.positions.register({
        position_id: 'deal-99',
        opportunity_id: 'opp-desk-1',
        intent_id: 'intent-desk-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4380,
        take_profit: 4450,
        decision: {
          decision_id: 'd-desk',
          kind: 'BUY',
          side: 'BUY',
          score: 0.8,
          block_reason: null,
          buy: { score: 0.8 } as never,
          sell: { score: 0.2 } as never,
          analysis: analysis() as never,
          expectancy: null,
        },
      });

      const booked = masterRuntime.recordDeskOwnedClose({
        position_id: 'deal-99',
        epic: 'GOLD',
        side: 'BUY',
        volume: 0.1,
        exit: 4385,
        reason: 'HardInvalidation · SCALP',
        ok: true,
        detail: 'capital_close_ok',
      });
      expect(booked.journaled).toBe(true);
      expect(booked.booked_local).toBe(true);
      expect(masterRuntime.positions.count()).toBe(0);
      expect(masterRuntime.last_exit_reason).toMatch(/DESK_HARD/);
      expect(masterRuntime.status().manage_owner).toBe('DESK_DEFERRED_HARD');

      const ev = loadTradeEvents(5).find((e) => e.position_id === 'deal-99');
      expect(ev).toBeTruthy();
      expect(ev!.ok).toBe(true);
      expect(ev!.detail).toMatch(/DESK_DEFERRED_HARD/);
      expect(ev!.detail).toMatch(/HardInvalidation/);

      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.journal_performance.ok).toBe(true);
      expect(stages.journal_performance.detail).toMatch(/trade events|trades=/);
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      masterRuntime.positions = prevPositions;
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

  it('exitTrade calls recordDeskOwnedClose when owns (source)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./robotDesk.ts', import.meta.url)),
      'utf8'
    );
    expect(src).toMatch(/recordDeskOwnedClose/);
    expect(src).toMatch(/DESK_DEFERRED_HARD|masterOwnsPipeline\(\)/);
    // both success and fail paths
    expect(src.match(/recordDeskOwnedClose/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
