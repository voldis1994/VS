/**
 * Persist operator-tunable MASTER manage knobs (survive restart).
 * Full MasterConfig is large — only manage/exit/risk toggles are stored.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { MasterConfig } from './types.js';
import { atomicWriteJson } from './atomicIo.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';

export type ManageConfigPatch = Partial<
  Pick<
    MasterConfig,
    | 'scalp_pct_chase'
    | 'scalp_lock_pct'
    | 'scalp_strict_entry'
    | 'scalp_min_edge'
    | 'ema_tick_entry'
    | 'soft_trail_money_arm'
    | 'soft_trail_pips'
    | 'breakeven_activation_money'
    | 'breakeven_progress'
    | 'breakeven_offset'
    | 'be_start'
    | 'trail_start'
    | 'trail_lock'
    | 'partial_close_progress'
    | 'partial_close_volume'
    | 'multi_tp_count'
    | 'multi_tp_atr_mult'
    | 'close_all_profit'
    | 'close_all_loss'
    | 'profit_lock'
    | 'daily_loss_limit'
    | 'equity_floor'
    | 'max_hold_ms'
    | 'min_score'
    | 'block_high_impact_news'
    | 'block_off_hours'
    | 'require_positive_expectancy'
    | 'min_expectancy_samples'
  >
>;

const KEYS: (keyof ManageConfigPatch)[] = [
  'scalp_pct_chase',
  'scalp_lock_pct',
  'scalp_strict_entry',
  'scalp_min_edge',
  'ema_tick_entry',
  'soft_trail_money_arm',
  'soft_trail_pips',
  'breakeven_activation_money',
  'breakeven_progress',
  'breakeven_offset',
  'be_start',
  'trail_start',
  'trail_lock',
  'partial_close_progress',
  'partial_close_volume',
  'multi_tp_count',
  'multi_tp_atr_mult',
  'close_all_profit',
  'close_all_loss',
  'profit_lock',
  'daily_loss_limit',
  'equity_floor',
  'max_hold_ms',
  'min_score',
  'block_high_impact_news',
  'block_off_hours',
  'require_positive_expectancy',
  'min_expectancy_samples',
];

function stateDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function configPath(): string {
  return join(stateDir(), 'master_manage_config.json');
}

/** VS-System SCALPING-style manage preset — chase + soft trail + money BE + multi-TP. */
export const SCALP_MANAGE_PRESET: ManageConfigPatch = {
  scalp_pct_chase: true,
  scalp_lock_pct: 0.2,
  scalp_strict_entry: true,
  scalp_min_edge: 0.12,
  ema_tick_entry: true,
  soft_trail_money_arm: 0.05,
  soft_trail_pips: 0.3,
  breakeven_activation_money: 0.05,
  breakeven_progress: 0,
  multi_tp_count: 3,
  multi_tp_atr_mult: 1.5,
};

export function pickManageConfig(cfg: MasterConfig): ManageConfigPatch {
  const out: ManageConfigPatch = {};
  for (const k of KEYS) {
    if (cfg[k] !== undefined) (out as Record<string, unknown>)[k] = cfg[k];
  }
  return out;
}

export function applyManageConfigPatch(
  cfg: MasterConfig,
  patch: ManageConfigPatch
): MasterConfig {
  const next = { ...cfg };
  for (const k of KEYS) {
    if (patch[k] !== undefined) {
      (next as Record<string, unknown>)[k] = patch[k];
    }
  }
  return next;
}

export function saveManageConfig(patch: ManageConfigPatch): boolean {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const ok = atomicWriteJson(configPath(), patch);
    if (ok) {
      // Keep operator_meta in sync even when no position write flushes FilePersist
      embedOperatorMetaPatch({ manage: patch as Record<string, unknown> });
    }
    return ok;
  } catch {
    return false;
  }
}

export function loadManageConfig(): ManageConfigPatch | null {
  try {
    const path = configPath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ManageConfigPatch;
    if (!raw || typeof raw !== 'object') return null;
    const clean: ManageConfigPatch = {};
    for (const k of KEYS) {
      if (raw[k] !== undefined) (clean as Record<string, unknown>)[k] = raw[k];
    }
    return clean;
  } catch {
    return null;
  }
}
