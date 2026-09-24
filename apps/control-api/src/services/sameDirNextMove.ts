/**
 * Same-direction re-entry must see the next move still with our side.
 * Blind re-open after exit (esp. after Soft) was Funds SELL spam 10:27→10:44.
 */
import {
  closed1mProfitPolicy,
  type CandleOHLC,
  type ExitSide,
} from './exitManage.js';
import { peekNextEntrySide } from './softExitMarketGate.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { entrySameDirConfirmEnabled } from './tradeOpenPolicy.js';

export type SameDirNextMoveResult =
  | { ok: true; tag: string }
  | { ok: false; reason: string };

export function sameDirNextMoveConfirms(input: {
  side: ExitSide;
  regime?: string | null;
  closedBars?: TenSecBar[] | null;
  closed1m?: CandleOHLC | null;
  prevClosed1m?: CandleOHLC | null;
}): SameDirNextMoveResult {
  const { side } = input;
  if (!entrySameDirConfirmEnabled()) {
    return { ok: true, tag: 'open · no same-dir gate' };
  }

  let minute: 'continue' | 'reverse' | 'wait' | 'unknown' = 'unknown';
  if (input.closed1m) {
    minute = closed1mProfitPolicy(
      side,
      input.closed1m,
      input.prevClosed1m ?? null
    );
  }

  if (minute === 'continue') {
    return { ok: true, tag: `1m continue ${side}` };
  }
  if (minute === 'reverse') {
    return {
      ok: false,
      reason: `1m reverse · ne same-dir ${side} · gaida next-move confirm`,
    };
  }

  const next = peekNextEntrySide({
    regime: input.regime,
    closedBars: input.closedBars,
  });
  if (next?.side === side) {
    return { ok: true, tag: `next entry ${side} ${next.setup}` };
  }
  if (next?.side && next.side !== side) {
    return {
      ok: false,
      reason: `next entry ${next.side} · bloķē same-dir ${side}`,
    };
  }

  return {
    ok: false,
    reason: `nav next-move confirm ${side} · 1m=${minute} · next=none · GAIDI`,
  };
}
