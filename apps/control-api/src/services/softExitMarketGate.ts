/**
 * Soft-exit market-change gate.
 *
 * Peak / Target / TimeDecay must NOT cut a winner while the same thesis
 * is still alive — that takes a tiny slice of the move and lets the rest go.
 *
 * Before any soft profit exit:
 * 1) Closed 1m still with our side → HOLD
 * 2) Peek next entry on the last full closed 10s candle — same side → HOLD
 * 3) Soft exit only when the market changed (1m reverse and/or opposite next entry)
 *
 * HardInv / structure kill are NEVER gated here.
 */
import {
  closed1mProfitPolicy,
  type CandleOHLC,
  type ExitSide,
} from './exitManage.js';
import { decideEntryWithStructure } from './structureEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type SoftExitGateResult = {
  /** true → Peak/Target/TimeDecay may fire */
  allow: boolean;
  hold_reason: string;
  next_entry_side: ExitSide | null;
  next_entry_setup: string | null;
  minute_policy: 'continue' | 'reverse' | 'wait' | 'unknown';
};

export type SoftExitGateInput = {
  openSide: ExitSide;
  /** Live regime for next-entry peek (not frozen entry_regime) */
  regime?: string | null;
  closedBars?: TenSecBar[] | null;
  /** Last fully closed Capital 1m OHLC */
  closed1m?: CandleOHLC | null;
  prevClosed1m?: CandleOHLC | null;
};

/**
 * Peek what entry would arm on the last full closed 10s bar — never opens an order.
 */
export function peekNextEntrySide(input: {
  regime?: string | null;
  closedBars?: TenSecBar[] | null;
}): { side: ExitSide; setup: string; reason: string } | null {
  const bars = input.closedBars;
  if (!bars?.length) return null;
  const bar = bars[bars.length - 1];
  if (!bar || !Number.isFinite(bar.close)) return null;
  const sig = decideEntryWithStructure({
    bar,
    regime: input.regime,
    closedBars: bars,
  });
  if (!sig) return null;
  return { side: sig.direction, setup: sig.setup, reason: sig.reason };
}

/**
 * Soft profit exits only when the market has changed on a full candle.
 * Same-side continuation → HOLD so the larger part of the move is not abandoned.
 */
export function softExitMarketGate(input: SoftExitGateInput): SoftExitGateResult {
  const { openSide } = input;

  let minute_policy: SoftExitGateResult['minute_policy'] = 'unknown';
  if (input.closed1m) {
    minute_policy = closed1mProfitPolicy(
      openSide,
      input.closed1m,
      input.prevClosed1m ?? null
    );
  }

  // Full 1m still prints with our side — never soft-exit mid-leg
  if (minute_policy === 'continue') {
    return {
      allow: false,
      hold_reason: `SOFT HOLD · 1m continue ${openSide} · wait market change`,
      next_entry_side: null,
      next_entry_setup: null,
      minute_policy,
    };
  }

  const next = peekNextEntrySide({
    regime: input.regime,
    closedBars: input.closedBars,
  });
  const next_entry_side = next?.side ?? null;
  const next_entry_setup = next?.setup ?? null;

  // Next full-candle entry would still be our side — thesis continues
  if (next_entry_side === openSide) {
    return {
      allow: false,
      hold_reason: `SOFT HOLD · next entry still ${next_entry_side} ${next_entry_setup || ''} · ${next?.reason || 'same thesis'}`.trim(),
      next_entry_side,
      next_entry_setup,
      minute_policy,
    };
  }

  // Opposite next entry → market changed → soft exit OK
  if (next_entry_side && next_entry_side !== openSide) {
    return {
      allow: true,
      hold_reason: '',
      next_entry_side,
      next_entry_setup,
      minute_policy,
    };
  }

  // No opposite signal: only allow soft exit after a clear reverse 1m
  if (minute_policy === 'reverse') {
    return {
      allow: true,
      hold_reason: '',
      next_entry_side,
      next_entry_setup,
      minute_policy,
    };
  }

  // wait / unknown + no opposite entry → do not soft-cut (HardInv still protects)
  return {
    allow: false,
    hold_reason: `SOFT HOLD · no market change yet · 1m=${minute_policy} · next=none`,
    next_entry_side,
    next_entry_setup,
    minute_policy,
  };
}
