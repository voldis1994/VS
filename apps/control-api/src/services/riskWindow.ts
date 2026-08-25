/**
 * Simple 10-minute account risk window (operator rules):
 * - Target profit ≈ 10% of total equity (pass band 7–10%+)
 * - Open/close trades normally inside the window
 * - End of 10 min without ≥7% → cooldown next 10 min
 * - −10% of total equity (live or at window end) → cooldown next 10 min
 * - Hit +10% → bank: cooldown next 10 min (lock the target)
 */

export const RISK_WINDOW_MS = 10 * 60 * 1000;
export const RISK_TARGET_MIN_PCT = 0.07;
export const RISK_TARGET_MAX_PCT = 0.1;
export const RISK_MAX_LOSS_PCT = 0.1;

export type RiskSnapshot = {
  account_id: number;
  equity_start: number | null;
  realized_pnl: number;
  open_upl: number;
  pnl_pct: number | null;
  window_remaining_sec: number;
  cooldown_remaining_sec: number;
  status: 'SEEDING' | 'ACTIVE' | 'COOLDOWN' | 'BANKED' | 'STOPPED_LOSS';
  detail: string;
};

type AccountRisk = {
  windowStartMs: number;
  equityStart: number | null;
  realizedPnl: number;
  cooldownUntilMs: number;
  lastStatus: RiskSnapshot['status'];
  lastDetail: string;
};

const byAccount = new Map<number, AccountRisk>();

function ensure(accountId: number, now: number): AccountRisk {
  let s = byAccount.get(accountId);
  if (!s) {
    s = {
      windowStartMs: now,
      equityStart: null,
      realizedPnl: 0,
      cooldownUntilMs: 0,
      lastStatus: 'SEEDING',
      lastDetail: 'waiting equity',
    };
    byAccount.set(accountId, s);
  }
  return s;
}

function pct(pnl: number, equity: number): number {
  const e = Math.max(Math.abs(equity), 1e-9);
  return pnl / e;
}

/** Seed / refresh starting equity for the current window (Capital balance). */
export function setRiskEquity(accountId: number, equity: number, now = Date.now()): void {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  if (!Number.isFinite(equity) || equity <= 0) return;
  const s = ensure(accountId, now);
  if (s.equityStart == null || s.equityStart <= 0) {
    s.equityStart = equity;
  }
}

/** Record realized P&L when a trade closes (account currency). */
export function noteRiskTradePnl(accountId: number, pnl: number, now = Date.now()): void {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  if (!Number.isFinite(pnl)) return;
  const s = ensure(accountId, now);
  // Closes during cooldown do not count toward the next window
  if (s.cooldownUntilMs > now) return;
  s.realizedPnl += pnl;
}

function startCooldown(s: AccountRisk, now: number, status: RiskSnapshot['status'], detail: string) {
  s.cooldownUntilMs = now + RISK_WINDOW_MS;
  s.lastStatus = status;
  s.lastDetail = detail;
  // Next trading window starts when cooldown ends
  s.windowStartMs = s.cooldownUntilMs;
  s.realizedPnl = 0;
  s.equityStart = null; // re-seed equity when trading resumes
}

function rollFreshWindow(s: AccountRisk, now: number, detail: string) {
  s.windowStartMs = now;
  s.realizedPnl = 0;
  s.equityStart = null;
  s.cooldownUntilMs = 0;
  s.lastStatus = 'ACTIVE';
  s.lastDetail = detail;
}

/**
 * Evaluate window — call every robot cycle.
 * Returns whether NEW entries are allowed (manage/exit always continue).
 */
export function evaluateRiskWindow(
  accountId: number,
  openUpl: number,
  now = Date.now()
): { allowEntry: boolean; snapshot: RiskSnapshot } {
  const s = ensure(accountId, now);
  const upl = Number.isFinite(openUpl) ? openUpl : 0;
  const coolLeft = Math.max(0, s.cooldownUntilMs - now);

  if (coolLeft > 0) {
    const snapshot: RiskSnapshot = {
      account_id: accountId,
      equity_start: s.equityStart,
      realized_pnl: s.realizedPnl,
      open_upl: upl,
      pnl_pct: s.equityStart != null ? pct(s.realizedPnl + upl, s.equityStart) : null,
      window_remaining_sec: 0,
      cooldown_remaining_sec: Math.ceil(coolLeft / 1000),
      status: s.lastStatus === 'BANKED' || s.lastStatus === 'STOPPED_LOSS' ? s.lastStatus : 'COOLDOWN',
      detail: s.lastDetail || `RISK cooldown ${Math.ceil(coolLeft / 1000)}s`,
    };
    return { allowEntry: false, snapshot };
  }

  // Cooldown just ended — ensure window clock is current
  if (s.windowStartMs > now) s.windowStartMs = now;
  if (now - s.windowStartMs >= RISK_WINDOW_MS * 2) {
    // Stale / first resume
    s.windowStartMs = now;
    s.realizedPnl = 0;
  }

  if (s.equityStart == null || s.equityStart <= 0) {
    const snapshot: RiskSnapshot = {
      account_id: accountId,
      equity_start: null,
      realized_pnl: s.realizedPnl,
      open_upl: upl,
      pnl_pct: null,
      window_remaining_sec: Math.ceil(
        Math.max(0, RISK_WINDOW_MS - (now - s.windowStartMs)) / 1000
      ),
      cooldown_remaining_sec: 0,
      status: 'SEEDING',
      detail: 'RISK seeding equity from Capital',
    };
    s.lastStatus = 'SEEDING';
    s.lastDetail = snapshot.detail;
    // Allow entries while seeding so robot is not frozen forever if balance API lags
    return { allowEntry: true, snapshot };
  }

  const totalPnl = s.realizedPnl + upl;
  const pnlPct = pct(totalPnl, s.equityStart);
  const windowLeft = Math.max(0, RISK_WINDOW_MS - (now - s.windowStartMs));

  // Live hard stop: −10% of total equity
  if (pnlPct <= -RISK_MAX_LOSS_PCT) {
    startCooldown(
      s,
      now,
      'STOPPED_LOSS',
      `RISK −${(Math.abs(pnlPct) * 100).toFixed(1)}% ≤ −10% · cooldown 10min`
    );
    return {
      allowEntry: false,
      snapshot: {
        account_id: accountId,
        equity_start: s.equityStart,
        realized_pnl: 0,
        open_upl: upl,
        pnl_pct: pnlPct,
        window_remaining_sec: 0,
        cooldown_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
        status: 'STOPPED_LOSS',
        detail: s.lastDetail,
      },
    };
  }

  // Bank target: +10% hit inside window
  if (pnlPct >= RISK_TARGET_MAX_PCT) {
    startCooldown(
      s,
      now,
      'BANKED',
      `RISK +${(pnlPct * 100).toFixed(1)}% ≥ +10% target · bank · cooldown 10min`
    );
    return {
      allowEntry: false,
      snapshot: {
        account_id: accountId,
        equity_start: null,
        realized_pnl: 0,
        open_upl: upl,
        pnl_pct: pnlPct,
        window_remaining_sec: 0,
        cooldown_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
        status: 'BANKED',
        detail: s.lastDetail,
      },
    };
  }

  // Window ended — must have ≥7% or cooldown
  if (windowLeft <= 0) {
    if (pnlPct < RISK_TARGET_MIN_PCT) {
      startCooldown(
        s,
        now,
        'COOLDOWN',
        `RISK 10min done · +${(pnlPct * 100).toFixed(1)}% < +7% · cooldown 10min`
      );
      return {
        allowEntry: false,
        snapshot: {
          account_id: accountId,
          equity_start: null,
          realized_pnl: 0,
          open_upl: upl,
          pnl_pct: pnlPct,
          window_remaining_sec: 0,
          cooldown_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
          status: 'COOLDOWN',
          detail: s.lastDetail,
        },
      };
    }
    // Hit 7–10% band (or above min) — roll next window, keep trading
    rollFreshWindow(
      s,
      now,
      `RISK 10min OK · +${(pnlPct * 100).toFixed(1)}% ≥ +7% · new window`
    );
    return {
      allowEntry: true,
      snapshot: {
        account_id: accountId,
        equity_start: null,
        realized_pnl: 0,
        open_upl: upl,
        pnl_pct: null,
        window_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
        cooldown_remaining_sec: 0,
        status: 'ACTIVE',
        detail: s.lastDetail,
      },
    };
  }

  const snapshot: RiskSnapshot = {
    account_id: accountId,
    equity_start: s.equityStart,
    realized_pnl: s.realizedPnl,
    open_upl: upl,
    pnl_pct: pnlPct,
    window_remaining_sec: Math.ceil(windowLeft / 1000),
    cooldown_remaining_sec: 0,
    status: 'ACTIVE',
    detail: `RISK window ${(pnlPct * 100).toFixed(1)}% · target 7–10% · ${Math.ceil(windowLeft / 1000)}s left`,
  };
  s.lastStatus = 'ACTIVE';
  s.lastDetail = snapshot.detail;
  return { allowEntry: true, snapshot };
}

export function allowRiskEntry(
  accountId: number,
  openUpl: number,
  now = Date.now()
): { ok: boolean; reason: string; snapshot: RiskSnapshot } {
  const { allowEntry, snapshot } = evaluateRiskWindow(accountId, openUpl, now);
  return {
    ok: allowEntry,
    reason: snapshot.detail,
    snapshot,
  };
}

export function getRiskSnapshot(
  accountId: number,
  openUpl = 0,
  now = Date.now()
): RiskSnapshot {
  return evaluateRiskWindow(accountId, openUpl, now).snapshot;
}

/** Test helper */
export function resetRiskWindows(): void {
  byAccount.clear();
}
