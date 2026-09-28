/**
 * Extra confirmation gate for Soft PROFIT exits only.
 *
 * decideOpenManageExit() is unchanged. When it returns a profit reason
 * (Peak / Target / TimeDecay / MindBank / MindCut), do NOT close yet —
 * wait for the next fully closed Capital 1m candle:
 *   BUY  → close only if close < open
 *   SELL → close only if close > open
 * If that next 1m is not opposite → continue MANAGE.
 *
 * HardInv / structure / other loss·safety reasons close immediately.
 */

export type ExitSide = 'BUY' | 'SELL';

export type ProfitExitConfirmState = {
  reason: string;
  /** Key of lastClosed Capital 1m when profit was first armed — wait for a newer key */
  armed_at_1m_key: string | null;
};

export type Closed1mSnap = {
  open: number;
  close: number;
  key: string;
};

export type ProfitConfirmDecision =
  | { action: 'exit_immediate'; reason: string }
  | { action: 'exit_profit'; reason: string }
  | { action: 'arm_and_wait'; state: ProfitExitConfirmState; detail: string }
  | { action: 'keep_waiting'; state: ProfitExitConfirmState; detail: string }
  | { action: 'reject_continue_manage'; detail: string }
  | { action: 'none' };

/** Soft profit banks — need opposite closed 1m before exitTrade. */
export function isProfitManageExitReason(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  if (!r) return false;
  return /PeakProtection|MindBank|MindCut|Target\s*\/|TimeDecay/i.test(r);
}

/** HardInv / structure / safety / unknown non-profit — close now. */
export function isImmediateManageExitReason(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  if (!r) return false;
  return !isProfitManageExitReason(r);
}

/**
 * BUY → opposite when close < open (red).
 * SELL → opposite when close > open (green).
 */
export function closed1mOppositeToSide(
  side: ExitSide,
  candle: { open: number; close: number }
): boolean {
  if (side === 'BUY') return candle.close < candle.open;
  return candle.close > candle.open;
}

export function capitalClosed1mKey(c: {
  open: number;
  high?: number;
  low?: number;
  close: number;
  snapshot_time_ms?: number | null;
}): string {
  if (c.snapshot_time_ms != null && Number.isFinite(c.snapshot_time_ms)) {
    return String(c.snapshot_time_ms);
  }
  const h = c.high ?? c.open;
  const l = c.low ?? c.close;
  return `ohlc:${c.open.toFixed(4)}:${h.toFixed(4)}:${l.toFixed(4)}:${c.close.toFixed(4)}`;
}

/**
 * Resolve whether to close now, arm wait, or continue MANAGE.
 * Call between decideOpenManageExit() and exitTrade().
 */
export function resolveProfitExitConfirm(input: {
  exitReason: string | null;
  openSide: ExitSide;
  pending: ProfitExitConfirmState | null;
  lastClosed1m: Closed1mSnap | null;
}): ProfitConfirmDecision {
  const { exitReason, openSide, pending, lastClosed1m } = input;

  // Loss / safety always wins — never wait for 1m confirm
  if (exitReason && isImmediateManageExitReason(exitReason)) {
    return { action: 'exit_immediate', reason: exitReason };
  }

  // Pending profit: evaluate the next fully closed 1m once it appears
  if (pending) {
    const nextKey = lastClosed1m?.key ?? null;
    const nextArrived =
      lastClosed1m != null && nextKey !== pending.armed_at_1m_key;

    if (!nextArrived) {
      return {
        action: 'keep_waiting',
        state: pending,
        detail: `PROFIT CONFIRM · wait next closed 1m · armed ${pending.reason.slice(0, 80)}`,
      };
    }

    if (closed1mOppositeToSide(openSide, lastClosed1m)) {
      return {
        action: 'exit_profit',
        reason: `${pending.reason} · 1m confirm ${openSide} opposite O=${lastClosed1m.open.toFixed(2)} C=${lastClosed1m.close.toFixed(2)}`,
      };
    }

    // Next 1m not opposite — drop pending; may re-arm below if still profit
    // fall through after reject if exitReason still profit
    if (exitReason && isProfitManageExitReason(exitReason)) {
      const armedKey = lastClosed1m.key;
      return {
        action: 'arm_and_wait',
        state: { reason: exitReason, armed_at_1m_key: armedKey },
        detail: `PROFIT CONFIRM · next 1m not opposite · re-arm · wait another closed 1m · ${openSide}`,
      };
    }

    return {
      action: 'reject_continue_manage',
      detail: `PROFIT CONFIRM · next 1m not opposite · continue MANAGE · ${openSide} O=${lastClosed1m.open.toFixed(2)} C=${lastClosed1m.close.toFixed(2)}`,
    };
  }

  if (exitReason && isProfitManageExitReason(exitReason)) {
    const armedKey = lastClosed1m?.key ?? null;
    return {
      action: 'arm_and_wait',
      state: { reason: exitReason, armed_at_1m_key: armedKey },
      detail: `PROFIT CONFIRM · armed · wait next closed 1m opposite ${openSide} · ${exitReason.slice(0, 72)}`,
    };
  }

  return { action: 'none' };
}

/**
 * Test / wiring helper — invokes `closeCapitalPosition` only when the gate
 * decides to exit (immediate loss/safety or confirmed opposite 1m).
 */
export async function applyProfitExitConfirmClose(input: {
  exitReason: string | null;
  openSide: ExitSide;
  pending: ProfitExitConfirmState | null;
  lastClosed1m: Closed1mSnap | null;
  closeCapitalPosition: (reason: string) => Promise<void> | void;
}): Promise<{
  decision: ProfitConfirmDecision;
  pending: ProfitExitConfirmState | null;
  closed: boolean;
}> {
  const decision = resolveProfitExitConfirm(input);
  if (decision.action === 'exit_immediate' || decision.action === 'exit_profit') {
    await input.closeCapitalPosition(decision.reason);
    return { decision, pending: null, closed: true };
  }
  if (decision.action === 'arm_and_wait' || decision.action === 'keep_waiting') {
    return { decision, pending: decision.state, closed: false };
  }
  return { decision, pending: null, closed: false };
}
