/**
 * Persist post-loss / reject cooldowns across restart.
 * File-backed (MASTER_STATE_DIR) — works for standalone and as dual mirror for API.
 */
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './atomicIo.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';

export type RuntimeGates = {
  last_loss_ms: number;
  reject_until_ms: number;
  /** Ambiguous OPEN window — survive restart so we do not double-open */
  inflight_until_ms?: number | null;
  /** VS-System post-exit skip — no same-tick / immediate re-entry after CLOSE */
  post_exit_until_ms?: number | null;
  /** epic:SIDE fingerprint set only after protective SL sync confirms */
  last_entry_fingerprint?: string | null;
  /** Equity baseline for daily $ gates — must survive restart */
  day_start_equity?: number | null;
  peak_equity?: number | null;
  /** UTC day that day_start_equity / daily_pnl belong to */
  daily_pnl_day?: string | null;
  /** Trailing loss streak — Check- persists; rebuild from journal can be order-wrong */
  consecutive_losses?: number | null;
  /**
   * true when day_start/peak were seeded from proven Capital equity.
   * Prevents paper £10k gates from poisoning Capital LIVE after attach/restart.
   */
  capital_day_gates_seeded?: boolean;
  /**
   * Last AI soft-exit allow_close. When ai_mode !== 'off' and missing after
   * restart, manage must fail-closed (false) until a cycle proves allow.
   */
  last_ai_allow_close?: boolean | null;
  /** Operator AI gate mode — survive restart (control API mutates live cfg). */
  ai_mode?: 'off' | 'advisory' | 'required' | null;
  /** Hard kill — must survive crash/restart or recover resumes entries. */
  kill_switch?: boolean | null;
  /** Operator mode — PAPER/LIVE/BACKTEST session survives restart. */
  mode?: 'PAPER' | 'LIVE' | 'BACKTEST' | null;
  /** Trading epic — wrong-epic window after crash is unsafe on Capital. */
  epic?: string | null;
  /** Desk dual-brain: pause new entries while exits still run. */
  entries_armed?: boolean | null;
  entries_pause_reason?: string | null;
  /** Sticky last close/flatten fail for dashboard after restart. */
  last_close_failed?: {
    position_id: string;
    exit_reason: string;
    detail: string;
    ts: string;
  } | null;
  /**
   * Operator wanted the cycle running before crash — resume feed/entries on boot.
   * Distinct from in-memory `running` (always false until start/resume).
   */
  desired_running?: boolean | null;
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

function normalizeRuntimeGates(gates: RuntimeGates): RuntimeGates {
  return {
    last_loss_ms: gates.last_loss_ms || 0,
    reject_until_ms: gates.reject_until_ms || 0,
    inflight_until_ms:
      gates.inflight_until_ms != null && Number.isFinite(gates.inflight_until_ms)
        ? Math.max(0, Math.floor(Number(gates.inflight_until_ms)))
        : 0,
    post_exit_until_ms:
      gates.post_exit_until_ms != null && Number.isFinite(gates.post_exit_until_ms)
        ? Math.max(0, Math.floor(Number(gates.post_exit_until_ms)))
        : 0,
    last_entry_fingerprint:
      gates.last_entry_fingerprint != null &&
      String(gates.last_entry_fingerprint).trim()
        ? String(gates.last_entry_fingerprint).trim().slice(0, 80)
        : null,
    day_start_equity:
      gates.day_start_equity != null && Number.isFinite(gates.day_start_equity)
        ? Number(gates.day_start_equity)
        : null,
    peak_equity:
      gates.peak_equity != null && Number.isFinite(gates.peak_equity)
        ? Number(gates.peak_equity)
        : null,
    daily_pnl_day: gates.daily_pnl_day ?? null,
    consecutive_losses:
      gates.consecutive_losses != null && Number.isFinite(gates.consecutive_losses)
        ? Math.max(0, Math.floor(Number(gates.consecutive_losses)))
        : null,
    capital_day_gates_seeded: gates.capital_day_gates_seeded === true,
    last_ai_allow_close:
      typeof gates.last_ai_allow_close === 'boolean'
        ? gates.last_ai_allow_close
        : null,
    ai_mode:
      gates.ai_mode === 'off' ||
      gates.ai_mode === 'advisory' ||
      gates.ai_mode === 'required'
        ? gates.ai_mode
        : null,
    kill_switch: gates.kill_switch === true,
    mode:
      gates.mode === 'PAPER' ||
      gates.mode === 'LIVE' ||
      gates.mode === 'BACKTEST'
        ? gates.mode
        : null,
    epic:
      gates.epic != null && String(gates.epic).trim()
        ? String(gates.epic).trim().slice(0, 40)
        : null,
    entries_armed:
      typeof gates.entries_armed === 'boolean' ? gates.entries_armed : null,
    entries_pause_reason:
      gates.entries_pause_reason != null &&
      String(gates.entries_pause_reason).trim()
        ? String(gates.entries_pause_reason).trim().slice(0, 120)
        : null,
    last_close_failed: (() => {
      const f = gates.last_close_failed;
      if (!f || typeof f !== 'object') return null;
      const position_id = String(f.position_id || '').trim().slice(0, 80);
      const exit_reason = String(f.exit_reason || '').trim().slice(0, 80);
      const detail = String(f.detail || '').trim().slice(0, 200);
      const ts = String(f.ts || '').trim().slice(0, 40);
      if (!position_id && !detail) return null;
      return { position_id, exit_reason, detail, ts };
    })(),
    desired_running: gates.desired_running === true,
  };
}

export function saveRuntimeGates(gates: RuntimeGates): boolean {
  try {
    mkdirSync(gatesDir(), { recursive: true });
    const payload = normalizeRuntimeGates(gates);
    const ok = atomicWriteJson(gatesPath(), payload);
    if (ok) {
      // Keep operator_meta in sync even when no position write flushes FilePersist
      embedOperatorMetaPatch({ gates: payload });
    }
    return ok;
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
    const streak = Number(raw.consecutive_losses);
    const fp =
      raw.last_entry_fingerprint != null && String(raw.last_entry_fingerprint).trim()
        ? String(raw.last_entry_fingerprint).trim().slice(0, 80)
        : null;
    return {
      last_loss_ms: Number(raw.last_loss_ms) || 0,
      reject_until_ms: Number(raw.reject_until_ms) || 0,
      inflight_until_ms: Number(raw.inflight_until_ms) || 0,
      post_exit_until_ms: Number(raw.post_exit_until_ms) || 0,
      last_entry_fingerprint: fp,
      day_start_equity: Number.isFinite(dayStart) && dayStart > 0 ? dayStart : null,
      peak_equity: Number.isFinite(peak) && peak > 0 ? peak : null,
      daily_pnl_day:
        raw.daily_pnl_day != null && String(raw.daily_pnl_day).trim()
          ? String(raw.daily_pnl_day).trim().slice(0, 10)
          : null,
      consecutive_losses:
        raw.consecutive_losses == null || raw.consecutive_losses === ''
          ? null
          : Number.isFinite(streak) && streak >= 0
            ? Math.floor(streak)
            : null,
      capital_day_gates_seeded: raw.capital_day_gates_seeded === true,
      last_ai_allow_close:
        typeof raw.last_ai_allow_close === 'boolean'
          ? raw.last_ai_allow_close
          : null,
      ai_mode:
        raw.ai_mode === 'off' ||
        raw.ai_mode === 'advisory' ||
        raw.ai_mode === 'required'
          ? raw.ai_mode
          : null,
      kill_switch: raw.kill_switch === true,
      mode:
        raw.mode === 'PAPER' || raw.mode === 'LIVE' || raw.mode === 'BACKTEST'
          ? raw.mode
          : null,
      epic:
        raw.epic != null && String(raw.epic).trim()
          ? String(raw.epic).trim().slice(0, 40)
          : null,
      entries_armed:
        typeof raw.entries_armed === 'boolean' ? raw.entries_armed : null,
      entries_pause_reason:
        raw.entries_pause_reason != null &&
        String(raw.entries_pause_reason).trim()
          ? String(raw.entries_pause_reason).trim().slice(0, 120)
          : null,
      last_close_failed: (() => {
        const f = raw.last_close_failed as RuntimeGates['last_close_failed'];
        if (!f || typeof f !== 'object') return null;
        const position_id = String(f.position_id || '').trim().slice(0, 80);
        const exit_reason = String(f.exit_reason || '').trim().slice(0, 80);
        const detail = String(f.detail || '').trim().slice(0, 200);
        const ts = String(f.ts || '').trim().slice(0, 40);
        if (!position_id && !detail) return null;
        return { position_id, exit_reason, detail, ts };
      })(),
      desired_running: raw.desired_running === true,
    };
  } catch {
    return null;
  }
}
