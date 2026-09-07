import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaperBroker } from '../broker.js';
import {
  applyManageConfigPatch,
  loadManageConfig,
  saveManageConfig,
  SCALP_MANAGE_PRESET,
} from '../manageConfig.js';
import { DEFAULT_MASTER_CONFIG, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { masterRuntime } from '../runtime.js';

describe('operator close + manage config', () => {
  beforeEach(() => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER' };
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.running = true;
    masterRuntime.last_quote = {
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
  });

  it('closePositionManual journals and drops local open', async () => {
    const broker = masterRuntime.ensurePaperBroker();
    broker.setQuote({
      bid: 4415,
      ask: 4415.4,
      mid: 4415.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'op-close-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
      profit_level: 4430,
    });
    masterRuntime.positions.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-op-close',
      intent_id: 'op-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      stop_loss: 4400,
      take_profit: 4430,
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
    expect(masterRuntime.positions.count()).toBe(1);
    const r = await masterRuntime.closePositionManual(
      placed.position_id!,
      'OPERATOR_CLOSE'
    );
    expect(r.ok).toBe(true);
    expect(masterRuntime.positions.count()).toBe(0);
    expect(masterRuntime.last_exit_reason).toBe('OPERATOR_CLOSE');
    expect(
      masterRuntime.pipeline.journal.opportunities.some(
        (o) => o.outcome?.exit_reason === 'OPERATOR_CLOSE'
      )
    ).toBe(true);
  });

  it('flattenAll closes every open', async () => {
    const broker = masterRuntime.ensurePaperBroker();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    for (let i = 0; i < 2; i++) {
      const placed = await broker.placeOrder({
        intent_id: `flat-${i}-bbbbbbbbbbbbbbbb`,
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        stop_level: 4390,
      });
      masterRuntime.positions.register({
        position_id: placed.position_id!,
        opportunity_id: `opp-flat-${i}`,
        intent_id: `fi-${i}`,
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4390,
        take_profit: null,
        decision: {
          decision_id: `d${i}`,
          kind: 'BUY',
          side: 'BUY',
          score: 0.6,
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
            swing_high: 4410,
            swing_low: 4390,
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
    }
    const r = await masterRuntime.flattenAll();
    expect(r.closed).toBe(2);
    expect(masterRuntime.positions.count()).toBe(0);
  });

  it('armScalpManagePreset persists chase + soft trail + multi-TP', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-cfg-'));
    process.env.MASTER_STATE_DIR = dir;
    const cfg = masterRuntime.armScalpManagePreset();
    expect(cfg.scalp_pct_chase).toBe(true);
    expect(cfg.soft_trail_money_arm).toBe(0.05);
    expect(cfg.multi_tp_count).toBe(3);
    const loaded = loadManageConfig();
    expect(loaded?.scalp_pct_chase).toBe(true);
    const st = masterRuntime.status();
    expect(st.manage.scalp_pct_chase).toBe(true);
    expect(st.quote?.mid).toBeCloseTo(4410.2, 1);
  });

  it('applyManageConfigPatch merges knobs', () => {
    const next = applyManageConfigPatch(DEFAULT_MASTER_CONFIG, {
      scalp_pct_chase: true,
      close_all_profit: 50,
    });
    expect(next.scalp_pct_chase).toBe(true);
    expect(next.close_all_profit).toBe(50);
    expect(next.min_score).toBe(DEFAULT_MASTER_CONFIG.min_score);
    expect(SCALP_MANAGE_PRESET.scalp_lock_pct).toBe(0.2);
    expect(saveManageConfig({ scalp_pct_chase: false })).toBe(true);
  });
});
