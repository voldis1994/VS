/**
 * Desk entry: 10s regime, then Capital-lag lead (BUY and SELL).
 * Does not invent a side on every dump/rally — that churns Gold 10s.
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
  // When direction came from C++ EntryReady, do not override it with Node-side
  // lag/leak heuristics — that would discard EV/transition formulas from calc.
  const fromCalc = input.intended != null;

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
    if (!fromCalc && direction !== lead.direction) {
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
      // If C++ already gave an intended side, do not flip it; block the entry instead.
      if (fromCalc) {
        return { direction: null, setup: null, reason: `STALE_QUOTE_BLOCK · ${stale.reason}` };
      }

      const flip: 'BUY' | 'SELL' = direction === 'BUY' ? 'SELL' : 'BUY';
      return {
        direction: flip,
        setup: 'LAG_LEAD',
        reason: `LAG CAPITAL · ${flip} · ${stale.reason}`,
      };
    }
  }

  // Last resort only in a lasting trend — RANGE/COMPRESSION must not flip every 10s.
  if (!direction && input.bar) {
    const regime = String(input.regime || '').toUpperCase();
    const trendingBuy =
      regime === 'TREND_UP' || regime === 'PULLBACK_UPTREND' || regime === 'BREAKOUT_UP';
    const trendingSell =
      regime === 'TREND_DOWN' || regime === 'PULLBACK_DOWNTREND' || regime === 'BREAKOUT_DOWN';
    if (trendingBuy && bias !== 'DOWN') {
      return {
        direction: 'BUY',
        setup: 'BIAS',
        reason: `BIAS ${bias} · BUY · ${input.regime || 'UNKNOWN'} closed 10s`,
      };
    }
    if (trendingSell && bias !== 'UP') {
      return {
        direction: 'SELL',
        setup: 'BIAS',
        reason: `BIAS ${bias} · SELL · ${input.regime || 'UNKNOWN'} closed 10s`,
      };
    }
  }

  return { direction, setup, reason };
}
