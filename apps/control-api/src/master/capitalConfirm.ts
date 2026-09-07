/**
 * Capital confirm parsing — ported from VS-System- broker-adapters.
 * POST /positions returns dealReference; fill comes from GET /confirms/{ref}.
 */
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
};

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
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
  return {
    dealId: pickStr(raw.dealId, fromAffected),
    dealStatus: pickStr(raw.dealStatus),
    status: pickStr(raw.status, affectedStatus),
    level: Number.isFinite(level) ? level : undefined,
    profit: Number.isFinite(Number(raw.profit)) ? Number(raw.profit) : undefined,
    size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : undefined,
    direction: raw.direction != null ? String(raw.direction) : undefined,
    epic: raw.epic != null ? String(raw.epic) : undefined,
    reason: pickStr(raw.reason, raw.errorCode, raw.rejectReason, affectedReason),
  };
}

export function isCapitalConfirmAccepted(c: CapitalConfirm): boolean {
  if ((c.dealStatus ?? '').toUpperCase() === 'REJECTED') return false;
  if ((c.status ?? '').toUpperCase() === 'REJECTED') return false;
  if (!c.dealId) return false;
  const ds = (c.dealStatus ?? '').toUpperCase();
  const st = (c.status ?? '').toUpperCase();
  if (ds === 'ACCEPTED') return true;
  if (st === 'OPEN' || st === 'ACCEPTED') return true;
  if (!ds && !st) return true;
  return false;
}
