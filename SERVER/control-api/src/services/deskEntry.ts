/**
 * Desk entry: 10s regime, then Capital-lag lead (BUY and SELL).
 * robotDesk hands still open Capital — this only picks the side.
 *
 * A closed 10s bar always yields BUY or SELL. SCAN is only for "no bar yet".
 */
import { decideEntryFrom10sRegime, type TrendBias } from './entryFromRegime.js';
import {
  detectCapitalLagLead,
  detectStaleQuoteAdverse,
  LAG_SCAN_MIN_REL,
  type PriceRef,
} from './staleQuoteGuard.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type DeskEntry = {
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  reason: string;
};

const FLIP_MIN_REL = 0.0012;

/** Closed 10s always has a side — dump follows DOWN/FLAT as SELL, UP as dip-buy. */
export function sideFromClosedBar(
  bar: TenSecBar,
  bias: TrendBias,
  regime?: string | null
): { direction: 'BUY' | 'SELL'; setup: string; reason: string } {
  const r = regime || 'UNKNOWN';
  if (bar.close < bar.open) {
    const direction: 'BUY' | 'SELL' = bias === 'UP' ? 'BUY' : 'SELL';
    return {
      direction,
      setup: direction === 'BUY' ? 'PULLBACK' : 'CONTINUATION',
      reason: `10s dump · ${direction} · ${r} · bias ${bias}`,
    };
  }
  if (bar.close > bar.open) {
    const direction: 'BUY' | 'SELL' = bias === 'DOWN' ? 'SELL' : 'BUY';
    return {
      direction,
      setup: 'CONTINUATION',
      reason: `10s rally · ${direction} · ${r} · bias ${bias}`,
    };
  }
  const direction: 'BUY' | 'SELL' = bias === 'DOWN' ? 'SELL' : 'BUY';
  return {
    direction,
    setup: 'BIAS',
    reason: `10s doji · ${direction} · ${r} · bias ${bias}`,
  };
}

export function resolveDeskEntry(input: {
  intended?: 'BUY' | 'SELL' | null;
  intendedSetup?: string | null;
  intendedReason?: string;
  bar?: TenSecBar | null;
  regime?: string | null;
  bias?: TrendBias;
  closedBars?: TenSecBar[] | null;
  capitalMid: number | null | undefined;
  refs: PriceRef[];
}): DeskEntry {
  let direction: 'BUY' | 'SELL' | null = input.intended ?? null;
  let setup: string | null = input.intendedSetup ?? null;
  let reason = input.intendedReason ?? '';
  const bias = input.bias || 'FLAT';

  if (!direction && input.bar) {
    const hit = decideEntryFrom10sRegime(
      input.bar,
      input.regime,
      bias,
      input.closedBars
    );
    if (hit) {
      direction = hit.direction;
      setup = hit.setup;
      reason = `10s ${hit.setup} · ${hit.reason}`;
    }
  }

  const lead = detectCapitalLagLead(input.capitalMid, input.refs, {
    minRel: direction ? FLIP_MIN_REL : LAG_SCAN_MIN_REL,
  });
  if (lead.hit && lead.direction) {
    if (!direction) {
      return { direction: lead.direction, setup: 'LAG_LEAD', reason: lead.reason };
    }
    if (direction !== lead.direction) {
      return {
        direction: lead.direction,
        setup: 'LAG_LEAD',
        reason: `FLIP ${direction} → ${lead.reason}`,
      };
    }
  }

  if (direction && setup !== 'LAG_LEAD') {
    const stale = detectStaleQuoteAdverse(direction, input.capitalMid, input.refs);
    if (stale.block) {
      const flip: 'BUY' | 'SELL' = direction === 'BUY' ? 'SELL' : 'BUY';
      return {
        direction: flip,
        setup: 'LAG_LEAD',
        reason: `LAG CAPITAL · ${flip} · ${stale.reason}`,
      };
    }
  }

  // Closed 10s must not sit in SCAN — dump/rally/doji always pick a side.
  if (!direction && input.bar) {
    const forced = sideFromClosedBar(input.bar, bias, input.regime);
    return forced;
  }

  if (!direction && (bias === 'UP' || bias === 'DOWN')) {
    const dir: 'BUY' | 'SELL' = bias === 'UP' ? 'BUY' : 'SELL';
    return {
      direction: dir,
      setup: 'BIAS',
      reason: `BIAS ${bias} · ${dir} · ${input.regime || 'UNKNOWN'}`,
    };
  }

  return { direction, setup, reason };
}
