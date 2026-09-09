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
    masterRuntime.last_loss_ms = 0;
    masterRuntime.last_close_failed = null;
    // Clear private cooldown gates so recover()/close cannot poison later suite tests
    const rt = masterRuntime as unknown as {
      post_exit_until_ms: number;
      reject_until_ms: number;
      inflight_until_ms: number;
    };
    rt.post_exit_until_ms = 0;
    rt.reject_until_ms = 0;
    rt.inflight_until_ms = 0;
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
      entry: placed.fill_price!,
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
    // Move mark into clear profit before operator close (spread already paid on entry)
    broker.setQuote({
      bid: 4420,
      ask: 4420.4,
      mid: 4420.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const r = await masterRuntime.closePositionManual(
      placed.position_id!,
      'OPERATOR_CLOSE'
    );
    expect(r.ok).toBe(true);
    expect(masterRuntime.positions.count()).toBe(0);
    expect(masterRuntime.last_exit_reason).toBe('OPERATOR_CLOSE');
    expect(masterRuntime.last_close_failed).toBeNull();
    expect(
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms
    ).toBeGreaterThan(Date.now() - 1000);
    expect(r.pnl).toBeGreaterThan(0);
    const opp = masterRuntime.pipeline.journal.opportunities.find(
      (o) => o.outcome?.exit_reason === 'OPERATOR_CLOSE'
    );
    expect(opp?.outcome?.r_multiple).toBeGreaterThan(0);
  });

  it('operator close failure sets last_close_failed + journals ok:false', async () => {
    const broker = masterRuntime.ensurePaperBroker();
    broker.setQuote({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'op-fail-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: 4400,
      profit_level: 4430,
    });
    masterRuntime.positions.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-op-fail',
      intent_id: 'op-fail-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: placed.fill_price!,
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
    const orig = broker.closePosition.bind(broker);
    broker.closePosition = async () => ({ ok: false, detail: 'operator_sim_fail' });
    const r = await masterRuntime.closePositionManual(
      placed.position_id!,
      'OPERATOR_CLOSE'
    );
    broker.closePosition = orig;
    expect(r.ok).toBe(false);
    expect(masterRuntime.positions.count()).toBe(1);
    expect(masterRuntime.last_close_failed?.detail).toBe('operator_sim_fail');
    expect(masterRuntime.status().last_close_failed?.detail).toBe(
      'operator_sim_fail'
    );
  });

  it('post-fill fail-close uses unlocked close (no tickChain deadlock)', () => {
    const { readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const src = readFileSync(join(__dirname, '../runtime.ts'), 'utf8');
    const idx = src.indexOf('POST_FILL_SL_SYNC_FAIL');
    expect(idx).toBeGreaterThan(0);
    const window = src.slice(Math.max(0, idx - 280), idx + 40);
    expect(window).toMatch(/closePositionManualUnlocked/);
    expect(window).not.toMatch(/await this\.closePositionManual\(/);
  });

  it('unlocked close from inside tickChain completes (no deadlock)', async () => {
    const order: string[] = [];
    await (masterRuntime as unknown as { runOnTickChain: <T>(fn: () => Promise<T>) => Promise<T> })
      .runOnTickChain(async () => {
        order.push('tick-start');
        const r = await (
          masterRuntime as unknown as {
            closePositionManualUnlocked: (
              id: string,
              reason: string
            ) => Promise<{ ok: boolean }>;
          }
        ).closePositionManualUnlocked('no-such', 'TEST_UNLOCKED');
        order.push(r.ok ? 'ok' : 'missing');
      });
    order.push('tick-end');
    expect(order).toEqual(['tick-start', 'missing', 'tick-end']);
  });

  it('recover waits behind an in-flight tickChain task', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    const state = mkdtempSync(join(tmpdir(), 'vs-recover-chain-'));
    process.env.MASTER_STATE_DIR = state;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const rt = masterRuntime as unknown as {
      runOnTickChain: <T>(fn: () => Promise<T>) => Promise<T>;
      post_exit_until_ms: number;
      reject_until_ms: number;
    };
    try {
      const hold = rt.runOnTickChain(async () => {
        order.push('hold-start');
        await gate;
        order.push('hold-end');
      });
      const recP = masterRuntime.recover().then(() => {
        order.push('recover-done');
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(order).toEqual(['hold-start']);
      release();
      await Promise.all([hold, recP]);
      expect(order).toEqual(['hold-start', 'hold-end', 'recover-done']);
    } finally {
      rt.post_exit_until_ms = 0;
      rt.reject_until_ms = 0;
      masterRuntime.last_loss_ms = 0;
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
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
      require_positive_expectancy: true,
      min_expectancy_samples: 5,
      require_armed_setup: true,
    });
    expect(next.scalp_pct_chase).toBe(true);
    expect(next.close_all_profit).toBe(50);
    expect(next.require_positive_expectancy).toBe(true);
    expect(next.min_expectancy_samples).toBe(5);
    expect(next.require_armed_setup).toBe(true);
    expect(next.min_score).toBe(DEFAULT_MASTER_CONFIG.min_score);
    expect(SCALP_MANAGE_PRESET.scalp_lock_pct).toBe(0.2);
    expect(saveManageConfig({ scalp_pct_chase: false })).toBe(true);
  });

  it('saveManageConfig persists profit_lock/equity_floor atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-day-risk-'));
    process.env.MASTER_STATE_DIR = dir;
    expect(
      saveManageConfig({ profit_lock: 120, equity_floor: 9500, daily_loss_limit: 80 })
    ).toBe(true);
    const loaded = loadManageConfig();
    expect(loaded?.profit_lock).toBe(120);
    expect(loaded?.equity_floor).toBe(9500);
    expect(loaded?.daily_loss_limit).toBe(80);
    const { existsSync } = require('fs') as typeof import('fs');
    expect(existsSync(join(dir, 'master_manage_config.json.tmp'))).toBe(false);
  });

  it('saveOwnsPipelinePref is atomic (no leftover tmp)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-owns-atomic-'));
    process.env.MASTER_STATE_DIR = dir;
    const { saveOwnsPipelinePref, loadOwnsPipelinePref } = await import(
      '../ownsPipelinePref.js'
    );
    expect(saveOwnsPipelinePref(true)).toBe(true);
    expect(loadOwnsPipelinePref()).toBe(true);
    const { existsSync } = require('fs') as typeof import('fs');
    expect(existsSync(join(dir, 'owns_pipeline.json.tmp'))).toBe(false);
  });
});
