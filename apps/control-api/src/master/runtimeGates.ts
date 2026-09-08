/**
 * Persist post-loss / reject cooldowns across restart.
 * File-backed (MASTER_STATE_DIR) — works for standalone and as dual mirror for API.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export type RuntimeGates = {
  last_loss_ms: number;
  reject_until_ms: number;
  /** Equity baseline for daily $ gates — must survive restart */
  day_start_equity?: number | null;
  peak_equity?: number | null;
  /** UTC day that day_start_equity / daily_pnl belong to */
  daily_pnl_day?: string | null;
};

function gatesDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function gatesPath(): string {
  return join(gatesDir(), 'runtime_gates.json');
}

export function saveRuntimeGates(gates: RuntimeGates): boolean {
  try {
    mkdirSync(gatesDir(), { recursive: true });
    writeFileSync(
      gatesPath(),
      JSON.stringify({
        last_loss_ms: gates.last_loss_ms || 0,
        reject_until_ms: gates.reject_until_ms || 0,
        day_start_equity:
          gates.day_start_equity != null && Number.isFinite(gates.day_start_equity)
            ? Number(gates.day_start_equity)
            : null,
        peak_equity:
          gates.peak_equity != null && Number.isFinite(gates.peak_equity)
            ? Number(gates.peak_equity)
            : null,
        daily_pnl_day: gates.daily_pnl_day ?? null,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function loadRuntimeGates(): RuntimeGates | null {
  try {
    const path = gatesPath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RuntimeGates;
    const dayStart = Number(raw.day_start_equity);
    const peak = Number(raw.peak_equity);
    return {
      last_loss_ms: Number(raw.last_loss_ms) || 0,
      reject_until_ms: Number(raw.reject_until_ms) || 0,
      day_start_equity: Number.isFinite(dayStart) && dayStart > 0 ? dayStart : null,
      peak_equity: Number.isFinite(peak) && peak > 0 ? peak : null,
      daily_pnl_day:
        raw.daily_pnl_day != null && String(raw.daily_pnl_day).trim()
          ? String(raw.daily_pnl_day).trim().slice(0, 10)
          : null,
    };
  } catch {
    return null;
  }
}
