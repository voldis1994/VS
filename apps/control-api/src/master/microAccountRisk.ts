/**
 * Micro / demo Capital accounts (~tens of currency) cannot use equity-% risk:
 * peak_equity often stays at paper seed (10_000) → permanent max_drawdown, and
 * 1% of $44 cannot size GOLD min lot → volume_below_min.
 *
 * MASTER_MICRO_ACCOUNT=true → fixed min lot, % DD / daily / streak gates off.
 */
import type { AccountSnapshot, MasterConfig } from './types.js';

export function isMicroAccountMode(): boolean {
  const v = String(process.env.MASTER_MICRO_ACCOUNT || '')
    .trim()
    .toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** Patch config for micro accounts (idempotent). */
export function applyMicroAccountConfig(cfg: MasterConfig): MasterConfig {
  if (!isMicroAccountMode()) return cfg;
  return {
    ...cfg,
    // Fixed min lot — ignore risk_per_trade_pct sizing
    fixed_lot: cfg.fixed_lot > 0 ? cfg.fixed_lot : 0.01,
    reduce_lot_after_loss: false,
    // 0 = disabled in evaluateRisk
    risk_per_trade_pct: 0,
    max_drawdown_pct: 0,
    max_daily_loss_pct: 0,
    consecutive_loss_limit: 0,
    cooldown_ms_after_loss: 0,
  };
}

/**
 * Drop stale paper peak / loss streak that would otherwise keep DD honest
 * numbers wrong on the dashboard (gates are already off via config).
 * Mutates account; returns whether anything changed.
 */
export function reseedMicroAccountGates(account: AccountSnapshot): boolean {
  if (!isMicroAccountMode()) return false;
  let changed = false;
  const eq =
    account.equity > 0 && Number.isFinite(account.equity) ? account.equity : 0;
  if (eq > 0) {
    // Paper seed peak (e.g. 10_000) vs live ~44 → permanent DD display / gates
    if (!(account.peak_equity > 0) || account.peak_equity > eq * 1.25) {
      account.peak_equity = eq;
      changed = true;
    }
    if (!(account.day_start_equity > 0) || account.day_start_equity > eq * 1.25) {
      account.day_start_equity = eq;
      changed = true;
    }
  }
  if (account.consecutive_losses !== 0) {
    account.consecutive_losses = 0;
    changed = true;
  }
  return changed;
}
