/**
 * Simple 10-minute account risk window (operator rules):
 * - Clock starts on the FIRST trade (open/close) — sitting in WAIT does NOT burn the window
 * - Target ≈ 10%; pass band ≥7% realized at window end
 * - +10% anytime (realized or live) early → bank, cooldown 10 min
 * - −10% live (realized + open UPL) → cooldown 10 min
 * - Window end with trades but <+7% realized → cooldown 10 min
 * - Window end with ZERO trades → roll next window, NO cooldown (no setup ≠ failure)
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
  realized_pct: number | null;
  trades_in_window: number;
  window_remaining_sec: number;
  cooldown_remaining_sec: number;
  status: 'SEEDING' | 'IDLE' | 'ACTIVE' | 'COOLDOWN' | 'BANKED' | 'STOPPED_LOSS';
  detail: string;
};

type AccountRisk = {
  windowStartMs: number;
  equityStart: number | null;
  lastSeenEquity: number | null;
  realizedPnl: number;
  tradesInWindow: number;
  cooldownUntilMs: number;
  lastStatus: RiskSnapshot['status'];
  lastDetail: string;
  /** Equity known */
  equityReady: boolean;
  /** 10min clock running (after first trade) */
  clockRunning: boolean;
};

const byAccount = new Map<number, AccountRisk>();

function ensure(accountId: number, now: number): AccountRisk {
  let s = byAccount.get(accountId);
  if (!s) {
    s = {
      windowStartMs: now,
      equityStart: null,
      lastSeenEquity: null,
      realizedPnl: 0,
      tradesInWindow: 0,
      cooldownUntilMs: 0,
      lastStatus: 'SEEDING',
      lastDetail: 'waiting equity',
      equityReady: false,
      clockRunning: false,
    };
    byAccount.set(accountId, s);
  }
  return s;
}

function pct(pnl: number, equity: number): number {
  const e = Math.max(Math.abs(equity), 1e-9);
  return pnl / e;
}

function armEquity(s: AccountRisk, equity: number) {
  s.lastSeenEquity = equity;
  if (!s.equityReady || s.equityStart == null || s.equityStart <= 0) {
    s.equityStart = equity;
    s.equityReady = true;
  }
}

/** Seed / refresh equity. Does NOT start the 10min clock. */
export function setRiskEquity(accountId: number, equity: number, now = Date.now()): void {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  if (!Number.isFinite(equity) || equity <= 0) return;
  const s = ensure(accountId, now);
  s.lastSeenEquity = equity;
  if (s.cooldownUntilMs > now) return;
  armEquity(s, equity);
}

function startClock(s: AccountRisk, now: number) {
  if (s.clockRunning) return;
  s.clockRunning = true;
  s.windowStartMs = now;
  if (!s.equityReady && s.lastSeenEquity != null) armEquity(s, s.lastSeenEquity);
}

/** Call when a trade is opened — starts the 10min risk clock. */
export function noteRiskTradeOpen(accountId: number, now = Date.now()): void {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  const s = ensure(accountId, now);
  if (s.cooldownUntilMs > now) return;
  startClock(s, now);
  s.tradesInWindow += 1;
}

/** Record realized P&L when a trade closes (account currency). */
export function noteRiskTradePnl(accountId: number, pnl: number, now = Date.now()): void {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  if (!Number.isFinite(pnl)) return;
  const s = ensure(accountId, now);
  if (s.cooldownUntilMs > now) return;
  startClock(s, now);
  if (s.tradesInWindow < 1) s.tradesInWindow = 1;
  s.realizedPnl += pnl;
}

function startCooldown(s: AccountRisk, now: number, status: RiskSnapshot['status'], detail: string) {
  s.cooldownUntilMs = now + RISK_WINDOW_MS;
  s.lastStatus = status;
  s.lastDetail = detail;
  s.windowStartMs = s.cooldownUntilMs;
  s.realizedPnl = 0;
  s.tradesInWindow = 0;
  s.equityStart = null;
  s.equityReady = false;
  s.clockRunning = false;
}

function rollFreshWindow(s: AccountRisk, now: number, detail: string) {
  s.windowStartMs = now;
  s.realizedPnl = 0;
  s.tradesInWindow = 0;
  s.cooldownUntilMs = 0;
  s.clockRunning = false; // idle until next trade
  s.lastStatus = 'IDLE';
  s.lastDetail = detail;
  if (s.lastSeenEquity != null && s.lastSeenEquity > 0) {
    s.equityStart = s.lastSeenEquity;
    s.equityReady = true;
  } else {
    s.equityStart = null;
    s.equityReady = false;
  }
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
      pnl_pct: null,
      realized_pct: null,
      trades_in_window: s.tradesInWindow,
      window_remaining_sec: 0,
      cooldown_remaining_sec: Math.ceil(coolLeft / 1000),
      status: s.lastStatus === 'BANKED' || s.lastStatus === 'STOPPED_LOSS' ? s.lastStatus : 'COOLDOWN',
      detail: s.lastDetail || `RISK cooldown ${Math.ceil(coolLeft / 1000)}s`,
    };
    return { allowEntry: false, snapshot };
  }

  // Cooldown ended — restore equity, stay IDLE until next trade
  if (!s.equityReady && s.lastSeenEquity != null && s.lastSeenEquity > 0) {
    armEquity(s, s.lastSeenEquity);
  }

  if (!s.equityReady || s.equityStart == null || s.equityStart <= 0) {
    const snapshot: RiskSnapshot = {
      account_id: accountId,
      equity_start: null,
      realized_pnl: s.realizedPnl,
      open_upl: upl,
      pnl_pct: null,
      realized_pct: null,
      trades_in_window: 0,
      window_remaining_sec: 0,
      cooldown_remaining_sec: 0,
      status: 'SEEDING',
      detail: 'RISK wait equity · no entry until Capital balance known',
    };
    s.lastStatus = 'SEEDING';
    s.lastDetail = snapshot.detail;
    return { allowEntry: false, snapshot };
  }

  const equity = s.equityStart;

  // Idle: waiting for quality setup — do NOT burn 10min clock, do NOT cooldown
  if (!s.clockRunning) {
    const snapshot: RiskSnapshot = {
      account_id: accountId,
      equity_start: equity,
      realized_pnl: 0,
      open_upl: upl,
      pnl_pct: pct(upl, equity),
      realized_pct: 0,
      trades_in_window: 0,
      window_remaining_sec: 0,
      cooldown_remaining_sec: 0,
      status: 'IDLE',
      detail: 'RISK idle · clock starts on first trade · waiting quality setup',
    };
    s.lastStatus = 'IDLE';
    s.lastDetail = snapshot.detail;
    return { allowEntry: true, snapshot };
  }

  const realizedPct = pct(s.realizedPnl, equity);
  const livePct = pct(s.realizedPnl + upl, equity);
  const windowLeft = Math.max(0, RISK_WINDOW_MS - (now - s.windowStartMs));

  if (livePct <= -RISK_MAX_LOSS_PCT) {
    const detail = `RISK −${(Math.abs(livePct) * 100).toFixed(1)}% ≤ −10% · cooldown 10min`;
    startCooldown(s, now, 'STOPPED_LOSS', detail);
    return {
      allowEntry: false,
      snapshot: {
        account_id: accountId,
        equity_start: equity,
        realized_pnl: 0,
        open_upl: upl,
        pnl_pct: livePct,
        realized_pct: realizedPct,
        trades_in_window: s.tradesInWindow,
        window_remaining_sec: 0,
        cooldown_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
        status: 'STOPPED_LOSS',
        detail,
      },
    };
  }

  if (realizedPct >= RISK_TARGET_MAX_PCT || livePct >= RISK_TARGET_MAX_PCT) {
    const hit = Math.max(realizedPct, livePct);
    const via = realizedPct >= RISK_TARGET_MAX_PCT ? 'realized' : 'live';
    const detail = `RISK +${(hit * 100).toFixed(1)}% ≥ +10% ${via} · bank early · cooldown 10min · netirgo`;
    startCooldown(s, now, 'BANKED', detail);
    return {
      allowEntry: false,
      snapshot: {
        account_id: accountId,
        equity_start: equity,
        realized_pnl: 0,
        open_upl: upl,
        pnl_pct: livePct,
        realized_pct: realizedPct,
        trades_in_window: s.tradesInWindow,
        window_remaining_sec: 0,
        cooldown_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
        status: 'BANKED',
        detail,
      },
    };
  }

  if (windowLeft <= 0) {
    // No trades taken (shouldn't normally happen if clock starts on trade) — no penalty
    if (s.tradesInWindow <= 0) {
      rollFreshWindow(s, now, 'RISK 10min · 0 trades · no penalty · idle');
      return {
        allowEntry: true,
        snapshot: {
          account_id: accountId,
          equity_start: s.equityStart,
          realized_pnl: 0,
          open_upl: upl,
          pnl_pct: s.equityStart != null ? pct(upl, s.equityStart) : null,
          realized_pct: 0,
          trades_in_window: 0,
          window_remaining_sec: 0,
          cooldown_remaining_sec: 0,
          status: 'IDLE',
          detail: s.lastDetail,
        },
      };
    }
    if (realizedPct < RISK_TARGET_MIN_PCT) {
      const detail = `RISK 10min done · ${s.tradesInWindow} trades · +${(realizedPct * 100).toFixed(1)}% < +7% · cooldown 10min`;
      startCooldown(s, now, 'COOLDOWN', detail);
      return {
        allowEntry: false,
        snapshot: {
          account_id: accountId,
          equity_start: equity,
          realized_pnl: 0,
          open_upl: upl,
          pnl_pct: livePct,
          realized_pct: realizedPct,
          trades_in_window: 0,
          window_remaining_sec: 0,
          cooldown_remaining_sec: Math.ceil(RISK_WINDOW_MS / 1000),
          status: 'COOLDOWN',
          detail,
        },
      };
    }
    rollFreshWindow(
      s,
      now,
      `RISK 10min OK · +${(realizedPct * 100).toFixed(1)}% ≥ +7% · idle until next trade`
    );
    return {
      allowEntry: true,
      snapshot: {
        account_id: accountId,
        equity_start: s.equityStart,
        realized_pnl: 0,
        open_upl: upl,
        pnl_pct: s.equityStart != null ? pct(upl, s.equityStart) : null,
        realized_pct: 0,
        trades_in_window: 0,
        window_remaining_sec: 0,
        cooldown_remaining_sec: 0,
        status: 'IDLE',
        detail: s.lastDetail,
      },
    };
  }

  const snapshot: RiskSnapshot = {
    account_id: accountId,
    equity_start: equity,
    realized_pnl: s.realizedPnl,
    open_upl: upl,
    pnl_pct: livePct,
    realized_pct: realizedPct,
    trades_in_window: s.tradesInWindow,
    window_remaining_sec: Math.ceil(windowLeft / 1000),
    cooldown_remaining_sec: 0,
    status: 'ACTIVE',
    detail: `RISK active · ${s.tradesInWindow} trades · realized ${(realizedPct * 100).toFixed(1)}% (live ${(livePct * 100).toFixed(1)}%) · target 7–10% · ${Math.ceil(windowLeft / 1000)}s left`,
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
