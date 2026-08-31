/** 10s OHLC + playbook entry — regime picks LONG / SCALP / FADE / WAIT. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import {
  bodyStrongEnough,
  dipFor,
  movingFor,
  nearRangeEdge,
  playbookFromRegime,
  rallyFor,
  wasRangeOrExpansion,
  wasTrend,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  playbook: TradePlaybook;
  reason: string;
};

export type EntryContext = {
  /** Consecutive closed bars in the current regime name */
  regimeAgeBars?: number;
  /** Consecutive bars in the same playbook family (LONG/SCALP/FADE) */
  playbookAgeBars?: number;
  previousRegime?: string | null;
  /** Prior closed bars (excluding the signal bar) for RANGE edge */
  priorBars?: TenSecBar[];
};

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

function familyAgeOk(ctx: EntryContext | undefined, need: number): boolean {
  return (ctx?.playbookAgeBars ?? ctx?.regimeAgeBars ?? 0) >= need;
}

/**
 * Suitable entry for the current 10s regime via playbook rules.
 * Returns null = WAIT.
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  ctx?: EntryContext
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const book: Playbook = playbookFromRegime(r);
  const candle = describe(bar);

  if (book === 'WAIT') return null;

  if (book === 'LONG') {
    if (!familyAgeOk(ctx, 3)) return null;
    if (wasRangeOrExpansion(ctx?.previousRegime) && (ctx?.regimeAgeBars ?? 0) < 2) {
      return null;
    }
    if (!movingFor(bar, 'LONG') || !bodyStrongEnough(bar, 'LONG')) return null;

    if (r === 'TREND_UP') {
      if (!dipFor(bar, 'LONG')) return null;
      return {
        direction: 'BUY',
        setup: 'PULLBACK',
        playbook: 'LONG',
        reason: `LONG · ${r} dip-buy · ${candle}`,
      };
    }
    if (r === 'TREND_DOWN') {
      if (!rallyFor(bar, 'LONG')) return null;
      return {
        direction: 'SELL',
        setup: 'PULLBACK',
        playbook: 'LONG',
        reason: `LONG · ${r} rally-sell · ${candle}`,
      };
    }
    if (r === 'PULLBACK_UPTREND') {
      if (!rallyFor(bar, 'LONG')) return null;
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        playbook: 'LONG',
        reason: `LONG · ${r} resume · ${candle}`,
      };
    }
    if (r === 'PULLBACK_DOWNTREND') {
      if (!dipFor(bar, 'LONG')) return null;
      return {
        direction: 'SELL',
        setup: 'CONTINUATION',
        playbook: 'LONG',
        reason: `LONG · ${r} resume · ${candle}`,
      };
    }
    return null;
  }

  if (book === 'SCALP') {
    if (!familyAgeOk(ctx, 2)) return null;
    if (!movingFor(bar, 'SCALP') || !bodyStrongEnough(bar, 'SCALP')) return null;

    if (r === 'BREAKOUT_UP') {
      if (!rallyFor(bar, 'SCALP')) return null;
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: 'SCALP',
        reason: `SCALP · ${r} follow · ${candle}`,
      };
    }
    if (r === 'BREAKOUT_DOWN') {
      if (!dipFor(bar, 'SCALP')) return null;
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: 'SCALP',
        reason: `SCALP · ${r} follow · ${candle}`,
      };
    }
    if (r === 'EXPANSION') {
      if (rallyFor(bar, 'SCALP')) {
        return {
          direction: 'BUY',
          setup: 'BREAKOUT',
          playbook: 'SCALP',
          reason: `SCALP · ${r} follow up · ${candle}`,
        };
      }
      if (dipFor(bar, 'SCALP')) {
        return {
          direction: 'SELL',
          setup: 'BREAKOUT',
          playbook: 'SCALP',
          reason: `SCALP · ${r} follow down · ${candle}`,
        };
      }
      return null;
    }
    if (r === 'REVERSAL_CANDIDATE') {
      if (dipFor(bar, 'SCALP')) {
        return {
          direction: 'SELL',
          setup: 'REVERSAL',
          playbook: 'SCALP',
          reason: `SCALP · ${r} · ${candle}`,
        };
      }
      if (rallyFor(bar, 'SCALP')) {
        return {
          direction: 'BUY',
          setup: 'REVERSAL',
          playbook: 'SCALP',
          reason: `SCALP · ${r} · ${candle}`,
        };
      }
      return null;
    }
    return null;
  }

  if (book === 'FADE') {
    if (wasTrend(ctx?.previousRegime) && (ctx?.regimeAgeBars ?? 0) <= 1) {
      return null;
    }
    if (!movingFor(bar, 'FADE') || !bodyStrongEnough(bar, 'FADE')) return null;

    if (r === 'FAILED_BREAKOUT_UP') {
      if (!dipFor(bar, 'FADE')) return null;
      return {
        direction: 'SELL',
        setup: 'FADE',
        playbook: 'FADE',
        reason: `FADE · ${r} · ${candle}`,
      };
    }
    if (r === 'FAILED_BREAKOUT_DOWN') {
      if (!rallyFor(bar, 'FADE')) return null;
      return {
        direction: 'BUY',
        setup: 'FADE',
        playbook: 'FADE',
        reason: `FADE · ${r} · ${candle}`,
      };
    }

    if (r === 'RANGE') {
      const prior = ctx?.priorBars || [];
      if (dipFor(bar, 'FADE')) {
        if (!nearRangeEdge(bar, prior, 'low')) return null;
        return {
          direction: 'BUY',
          setup: 'FADE',
          playbook: 'FADE',
          reason: `FADE · ${r} edge-low · ${candle}`,
        };
      }
      if (rallyFor(bar, 'FADE')) {
        if (!nearRangeEdge(bar, prior, 'high')) return null;
        return {
          direction: 'SELL',
          setup: 'FADE',
          playbook: 'FADE',
          reason: `FADE · ${r} edge-high · ${candle}`,
        };
      }
      return null;
    }
    return null;
  }

  return null;
}
