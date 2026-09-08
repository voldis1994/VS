/**
 * Capital confirm parsing — ported from VS-System- broker-adapters.
 * POST /positions returns dealReference; fill comes from GET /confirms/{ref}.
 */
import { isCapitalRiskCheckError } from './capitalSize.js';

export type CapitalConfirm = {
  dealId?: string;
  dealStatus?: string;
  status?: string;
  level?: number;
  profit?: number;
  size?: number;
  direction?: string;
  epic?: string;
  reason?: string;
  rawHint?: string;
};

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

/**
 * Parse optional numeric confirm fields.
 * Number(null) and Number('') are 0 — must NOT treat missing profit as realized 0.
 */
export function parseOptionalConfirmNumber(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCapitalConfirm(
  raw: Record<string, unknown> | null | undefined
): CapitalConfirm {
  if (!raw || typeof raw !== 'object') return {};
  const affected = Array.isArray(raw.affectedDeals) ? raw.affectedDeals : [];
  let fromAffected: string | undefined;
  let affectedReason: string | undefined;
  let affectedStatus: string | undefined;
  let affectedLevel: number | undefined;
  for (const row of affected) {
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>;
      const id = pickStr(r.dealId);
      if (id && !fromAffected) fromAffected = id;
      if (!affectedReason) affectedReason = pickStr(r.reason, r.errorCode, r.status);
      if (!affectedStatus) affectedStatus = pickStr(r.status);
      const lvl = Number(r.level ?? r.price);
      if (affectedLevel == null && Number.isFinite(lvl)) affectedLevel = lvl;
    }
  }
  const level = Number(raw.level ?? affectedLevel);
  const dealStatus = pickStr(raw.dealStatus);
  const status = pickStr(raw.status, affectedStatus);
  const reason = pickStr(
    raw.reason,
    raw.errorCode,
    raw.rejectReason,
    raw.rejectionReason,
    affectedReason
  );
  let rawHint: string | undefined;
  if (!reason && (dealStatus || status)) {
    try {
      rawHint = JSON.stringify(raw).slice(0, 280);
    } catch {
      rawHint = undefined;
    }
  }
  return {
    dealId: pickStr(raw.dealId, fromAffected),
    dealStatus,
    status,
    level: Number.isFinite(level) ? level : undefined,
    profit: parseOptionalConfirmNumber(raw.profit),
    size: parseOptionalConfirmNumber(raw.size),
    direction: raw.direction != null ? String(raw.direction) : undefined,
    epic: raw.epic != null ? String(raw.epic) : undefined,
    reason,
    rawHint,
  };
}

/** True when confirm is a final ACCEPTED/REJECTED (or OPEN/DELETED with dealId). */
export function isCapitalConfirmTerminal(c: CapitalConfirm): boolean {
  const ds = (c.dealStatus ?? '').toUpperCase();
  if (ds === 'ACCEPTED' || ds === 'REJECTED') return true;
  if (ds === 'DELETED' || ds === 'CLOSED' || ds === 'CANCELLED') return true;
  const st = (c.status ?? '').toUpperCase();
  if (
    c.dealId &&
    (st === 'OPEN' ||
      st === 'DELETED' ||
      st === 'ACCEPTED' ||
      st === 'CLOSED' ||
      st === 'CANCELLED')
  ) {
    return true;
  }
  return false;
}

export function isCapitalConfirmAccepted(c: CapitalConfirm): boolean {
  if ((c.dealStatus ?? '').toUpperCase() === 'REJECTED') return false;
  if ((c.status ?? '').toUpperCase() === 'REJECTED') return false;
  if (!c.dealId) return false;
  const ds = (c.dealStatus ?? '').toUpperCase();
  const st = (c.status ?? '').toUpperCase();
  if (ds === 'ACCEPTED') return true;
  if (st === 'OPEN' || st === 'ACCEPTED') return true;
  // Close confirms often land as DELETED/CLOSED (deal gone) without dealStatus=ACCEPTED
  if (st === 'DELETED' || st === 'CLOSED' || st === 'CANCELLED') return true;
  if (ds === 'DELETED' || ds === 'CLOSED' || ds === 'CANCELLED') return true;
  if (!ds && !st) return true;
  return false;
}

export function formatCapitalConfirmRejection(c: CapitalConfirm): string {
  const ds = (c.dealStatus ?? '').toUpperCase();
  if (ds === 'REJECTED' || (c.status ?? '').toUpperCase() === 'REJECTED') {
    return `Capital rejected: ${c.reason || c.rawHint || ds || 'REJECTED'}`;
  }
  return c.reason || c.rawHint || 'confirm_not_accepted';
}

/** Stop / min-distance / attached-order reject — widen or fail-close. */
export function isCapitalStopLevelReject(message: string): boolean {
  const r = String(message ?? '').toUpperCase();
  return (
    r.includes('STOP') ||
    r.includes('ATTACHED') ||
    r.includes('MINIMUM') ||
    r.includes('MIN_DISTANCE') ||
    r.includes('LEVEL') ||
    r.includes('DISTANCE') ||
    r.includes('GUARANTEED') ||
    r.includes('SL NOT MOVED') ||
    r.includes('STOPLEVEL') ||
    r.includes('DID NOT ACCEPT')
  );
}

export function capitalModifyRejectBackoffMs(message: string): number {
  if (isCapitalRiskCheckError(message)) return 300_000;
  if (isCapitalStopLevelReject(message)) return 120_000;
  return 90_000;
}

/** Stepped confirm poll delays (ms) — VS-System- waitConfirm pattern (shortened in tests). */
export const CAPITAL_CONFIRM_POLL_MS =
  process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true'
    ? [5, 10, 15, 25, 40, 60]
    : [50, 100, 150, 200, 300, 400, 500, 700, 900, 1200, 1600, 2200];
